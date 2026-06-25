import { Logger } from '@nestjs/common';
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE, BATCH_SIZE, COOLDOWN_BATCH_MS,
  sleep, generateSignature, parseJsonKeepingIds,
  isClosed, parseScheduleString, normalizeDate, getAuthTokens,
} from './didi-food.util';

const logger = new Logger('schedule_update_dates');

interface DateOverride {
  date: string;  // "YYYY-MM-DD"
  restAllDay: boolean;
  bizTime: { begin: number; end: number }[];
}

interface ShopDateSchedule {
  appShopId: string;
  overrides: DateOverride[];
}

// ── Excel reader ──────────────────────────────────────────────────────────────

/**
 * Excel format:
 *  Col A: app_shop_id
 *  Col B: Date 1  (Date cell or string "YYYY-MM-DD")
 *  Col C: Schedule 1 ("HH:MM-HH:MM" or "closed")
 *  Col D: Date 2
 *  Col E: Schedule 2
 *  ... unlimited pairs from col B onward
 */
async function readExcel(filePath: string): Promise<ShopDateSchedule[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const rows: ShopDateSchedule[] = [];

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const shopId = String(row.getCell(1).value ?? '').trim();
    if (!shopId) return;

    const overrides: DateOverride[] = [];
    // Pairs starting at col 2 (B), step 2
    let col = 2;
    while (true) {
      const dateCell = row.getCell(col).value;
      const schedCell = row.getCell(col + 1).value;
      if (dateCell == null && schedCell == null) break;

      let dateStr: string;
      if (dateCell instanceof Date) {
        dateStr = normalizeDate(dateCell);
      } else if (dateCell != null) {
        dateStr = normalizeDate(String(dateCell).trim());
      } else {
        col += 2;
        continue;
      }

      const raw = schedCell == null ? 'closed' : String(schedCell).trim();

      if (isClosed(raw)) {
        overrides.push({ date: dateStr, restAllDay: true, bizTime: [] });
      } else {
        try {
          const ranges = parseScheduleString(raw); // no buffer for date overrides
          overrides.push({ date: dateStr, restAllDay: false, bizTime: ranges });
        } catch {
          logger.warn(`Row ${rowNum}: invalid schedule "${raw}" for shop ${shopId} on ${dateStr} — treating as closed`);
          overrides.push({ date: dateStr, restAllDay: true, bizTime: [] });
        }
      }
      col += 2;
    }

    if (overrides.length > 0) {
      rows.push({ appShopId: shopId, overrides });
    }
  });

  return rows;
}

// ── DiDi API call ─────────────────────────────────────────────────────────────

async function updateShopDateSchedule(
  appId: string,
  token: string,
  country: string,
  shop: ShopDateSchedule,
): Promise<void> {
  const b = DIDI_BASE[country] ?? DIDI_BASE['MX'];
  const timestamp = String(Math.floor(Date.now() / 1000));

  const payload = {
    app_id: appId,
    access_token: token,
    timestamp,
    app_shop_id: shop.appShopId,
    biz_holiday_time: shop.overrides.map(o => ({
      date: o.date,
      rest_all_day: o.restAllDay,
      biz_time: o.bizTime,
    })),
  };

  const sign = generateSignature(
    { app_id: appId, access_token: token, timestamp, app_shop_id: shop.appShopId },
    token,
  );

  const res = await fetch(`${b}/v1/shop/holiday_time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, sign }),
  });

  const body = parseJsonKeepingIds(await res.text());
  if (body.errno !== 0) {
    throw new Error(`DiDi error (errno=${body.errno}): ${body.errmsg}`);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Reads an Excel file with date-specific schedule overrides and updates DiDi Food.
 * Used for holidays, special events, etc.
 *
 * Form fields:
 *  - "Excel File"  (file)  — required — uploaded .xlsx with date overrides
 *
 * Excel format (unlimited date/schedule pairs per shop):
 *  Col A:   app_shop_id
 *  Col B:   Date 1  (Date cell or "YYYY-MM-DD" string)
 *  Col C:   Schedule 1  ("HH:MM-HH:MM" or "closed")
 *  Col D:   Date 2
 *  Col E:   Schedule 2
 *  ...
 */
async function scheduleUpdateDates(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand)             throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const tempFile = ctx.field('Excel File');
  if (!tempFile)          throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);
  let shops: ShopDateSchedule[] = [];

  try {
    shops = await readExcel(filePath);
  } catch (err) {
    await unlink(filePath).catch(() => undefined);
    throw err;
  }

  if (shops.length === 0) {
    await unlink(filePath).catch(() => undefined);
    throw new Error('Excel file is empty or has no valid rows');
  }

  const { appId, appSecret } = brand.application;
  const { token, errors: authErrors } = await getAuthTokens(appId, appSecret, brand.country);
  if (!token) throw new Error(`Auth failed: ${authErrors.join('; ')}`);

  logger.log(`Processing ${shops.length} shops (date overrides) for brand=${brand.brandName} (${brand.country})`);

  const failed: { appShopId: string; error: string }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        await updateShopDateSchedule(appId, token, brand.country, shop);
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(`shop ${shop.appShopId}: ${msg}`);
        failed.push({ appShopId: shop.appShopId, error: msg });
        ctx.addNote(`✗ ${shop.appShopId}: ${msg}`);
      }
    }

    if (i + BATCH_SIZE < shops.length) await sleep(COOLDOWN_BATCH_MS);
  }

  if (failed.length > 0) {
    await ctx.sendAlert({
      text: `⚠️ schedule_update_dates — ${failed.length}/${shops.length} shops failed for **${brand.brandName}** (${brand.country})`,
      attachments: [{
        title: 'Failed shops',
        text: failed.map(f => `• ${f.appShopId}: ${f.error}`).join('\n'),
        color: '#F44336',
      }],
    });
  }

  await unlink(filePath).catch(() => undefined);

  if (failed.length === shops.length) {
    throw new Error(`All ${shops.length} shops failed — see notes for details`);
  }

  const ok = shops.length - failed.length;
  logger.log(`Done: ${ok} ok, ${failed.length} failed`);

  return {
    total: shops.length,
    success: ok,
    failed: failed.length,
    failedShops: failed,
  };
}

registerHandler('schedule_update_dates', scheduleUpdateDates);
