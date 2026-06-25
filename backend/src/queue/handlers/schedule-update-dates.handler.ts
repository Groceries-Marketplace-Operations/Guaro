import { Logger } from '@nestjs/common';
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE, BATCH_SIZE, COOLDOWN_BATCH_MS,
  sleep, parseJsonKeepingIds,
  isClosed, parseScheduleString, minutesToHHMM, normalizeDate, getAuthToken,
} from './didi-food.util';

const logger = new Logger('schedule_update_dates');

interface BizTimeRange { begin: string; end: string; }

interface DateOverride {
  bizHoliday: string;   // "YYYY-MM-DD"
  restAllDay: boolean;
  bizTime: BizTimeRange[];
}

interface ShopDateSchedule {
  appShopId: string;
  overrides: DateOverride[];
}

// ── Excel reader ──────────────────────────────────────────────────────────────

/**
 * Excel format (unlimited date/schedule pairs per shop, row 1 is header):
 *  Col A:   app_shop_id
 *  Col B:   Date 1  (Date cell or "YYYY-MM-DD" string)
 *  Col C:   Schedule 1  ("HH:MM-HH:MM" or "closed")
 *  Col D:   Date 2
 *  Col E:   Schedule 2
 *  ...
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
    let col = 2;
    while (true) {
      const dateCell = row.getCell(col).value;
      const schedCell = row.getCell(col + 1).value;
      if (dateCell == null && schedCell == null) break;

      let bizHoliday: string;
      if (dateCell instanceof Date) {
        bizHoliday = normalizeDate(dateCell);
      } else if (dateCell != null) {
        bizHoliday = normalizeDate(String(dateCell).trim());
      } else {
        col += 2;
        continue;
      }

      const raw = schedCell == null ? 'closed' : String(schedCell).trim();

      if (isClosed(raw)) {
        overrides.push({ bizHoliday, restAllDay: true, bizTime: [] });
      } else {
        try {
          const ranges = parseScheduleString(raw); // no buffer for date overrides
          overrides.push({
            bizHoliday,
            restAllDay: false,
            bizTime: ranges.map(r => ({ begin: minutesToHHMM(r.begin), end: minutesToHHMM(r.end) })),
          });
        } catch {
          logger.warn(`Row ${rowNum}: invalid schedule "${raw}" for shop ${shopId} on ${bizHoliday} — treating as closed`);
          overrides.push({ bizHoliday, restAllDay: true, bizTime: [] });
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
  token: string,
  shop: ShopDateSchedule,
): Promise<void> {
  const payload = {
    auth_token: token,
    app_shop_id: shop.appShopId,
    biz_holiday_time: shop.overrides.map(o => ({
      bizHoliday: o.bizHoliday,
      restAllDay: o.restAllDay,
      bizTime: o.bizTime,
    })),
  };

  const res = await fetch(`${DIDI_BASE}/v1/shop/shop/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = parseJsonKeepingIds(await res.text());
  if (body.errno !== 0) {
    throw new Error(`DiDi error (errno=${body.errno}): ${body.errmsg}`);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

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

  logger.log(`Processing ${shops.length} shops (date overrides) for brand=${brand.brandName} (${brand.country})`);

  const failed: { appShopId: string; error: string }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        const token = await getAuthToken(appId, appSecret, shop.appShopId);
        await updateShopDateSchedule(token, shop);
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

  const allFailed = failed.length === shops.length;
  if (!allFailed || ctx.isLastAttempt) {
    await unlink(filePath).catch(() => undefined);
  }

  if (allFailed) {
    throw new Error(`All ${shops.length} shops failed — see notes for details`);
  }

  const ok = shops.length - failed.length;
  logger.log(`Done: ${ok} ok, ${failed.length} failed`);

  return { total: shops.length, success: ok, failed: failed.length, failedShops: failed };
}

registerHandler('schedule_update_dates', scheduleUpdateDates);
