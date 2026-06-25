import { Logger } from '@nestjs/common';
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE, BATCH_SIZE, COOLDOWN_BATCH_MS, COOLDOWN_RETRY_MS,
  sleep, generateSignature, parseJsonKeepingIds,
  isClosed, parseScheduleString, applyBuffer, getAuthTokens,
} from './didi-food.util';

const logger = new Logger('schedule_update_permanent');

// Day-of-week mapping: Excel column index (1-based from B) → DiDi week number (1=Mon … 7=Sun)
const COL_TO_WEEK = [1, 2, 3, 4, 5, 6, 7]; // cols B-H

interface ShopSchedule {
  appShopId: string;
  bizDayTime: { week: number; bizTime: { begin: number; end: number }[] }[];
}

// ── Excel reader ──────────────────────────────────────────────────────────────

async function readExcel(filePath: string): Promise<ShopSchedule[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const rows: ShopSchedule[] = [];

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // skip header
    const shopId = String(row.getCell(1).value ?? '').trim();
    if (!shopId) return;

    const bizDayTime: ShopSchedule['bizDayTime'] = [];
    for (let col = 2; col <= 8; col++) {
      const cellVal = row.getCell(col).value;
      const raw = cellVal == null ? '' : String(cellVal).trim();
      const week = COL_TO_WEEK[col - 2];

      if (isClosed(raw)) {
        bizDayTime.push({ week, bizTime: [] });
      } else {
        try {
          const ranges = applyBuffer(parseScheduleString(raw));
          bizDayTime.push({ week, bizTime: ranges });
        } catch {
          logger.warn(`Row ${rowNum}: invalid schedule "${raw}" for shop ${shopId} (week ${week}) — treating as closed`);
          bizDayTime.push({ week, bizTime: [] });
        }
      }
    }
    rows.push({ appShopId: shopId, bizDayTime });
  });

  return rows;
}

// ── DiDi API call ─────────────────────────────────────────────────────────────

async function updateShopSchedule(
  appId: string,
  token: string,
  country: string,
  shop: ShopSchedule,
): Promise<void> {
  const b = DIDI_BASE[country] ?? DIDI_BASE['MX'];
  const timestamp = String(Math.floor(Date.now() / 1000));

  const payload = {
    app_id: appId,
    access_token: token,
    timestamp,
    app_shop_id: shop.appShopId,
    biz_day_time: shop.bizDayTime.map(d => ({
      week: d.week,
      biz_time: d.bizTime,
    })),
  };

  const sign = generateSignature(
    { app_id: appId, access_token: token, timestamp, app_shop_id: shop.appShopId },
    token,
  );

  const res = await fetch(`${b}/v1/shop/business_time`, {
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
 * Reads an Excel file with permanent weekly schedules and updates DiDi Food.
 *
 * Form fields:
 *  - "Excel File"  (file)  — required — uploaded .xlsx with shop schedules
 *
 * Excel format (one row per shop, no header row required but ignored if present):
 *  Col A: app_shop_id
 *  Col B: Monday   schedule ("HH:MM-HH:MM" or "closed")
 *  Col C: Tuesday  schedule
 *  Col D: Wednesday schedule
 *  Col E: Thursday schedule
 *  Col F: Friday   schedule
 *  Col G: Saturday schedule
 *  Col H: Sunday   schedule
 */
async function scheduleUpdatePermanent(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand)        throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const tempFile = ctx.field('Excel File');
  if (!tempFile)     throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);
  let shops: ShopSchedule[] = [];

  try {
    shops = await readExcel(filePath);
  } finally {
    await unlink(filePath).catch(() => undefined);
  }

  if (shops.length === 0) throw new Error('Excel file is empty or has no valid rows');

  const { appId, appSecret } = brand.application;
  const { token, errors: authErrors } = await getAuthTokens(appId, appSecret, brand.country);
  if (!token) throw new Error(`Auth failed: ${authErrors.join('; ')}`);

  logger.log(`Processing ${shops.length} shops for brand=${brand.brandName} (${brand.country})`);

  const failed: { appShopId: string; error: string }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        await updateShopSchedule(appId, token, brand.country, shop);
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
      text: `⚠️ schedule_update_permanent — ${failed.length}/${shops.length} shops failed for **${brand.brandName}** (${brand.country})`,
      attachments: [{
        title: 'Failed shops',
        text: failed.map(f => `• ${f.appShopId}: ${f.error}`).join('\n'),
        color: '#F44336',
      }],
    });
  }

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

registerHandler('schedule_update_permanent', scheduleUpdatePermanent);
