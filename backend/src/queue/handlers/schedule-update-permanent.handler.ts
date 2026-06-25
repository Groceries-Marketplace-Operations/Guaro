import { Logger } from '@nestjs/common';
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE, BATCH_SIZE, COOLDOWN_BATCH_MS,
  sleep, parseJsonKeepingIds,
  isClosed, parseScheduleString, applyBuffer, minutesToHHMM, getAuthToken,
} from './didi-food.util';

const logger = new Logger('schedule_update_permanent');

interface BizTimeRange { begin: string; end: string; }

interface ShopSchedule {
  appShopId: string;
  // Days with the same schedule are grouped: bizDay = [1..7], bizTime = HH:MM ranges
  dayGroups: { bizDay: number[]; bizTime: BizTimeRange[] }[];
}

// ── Excel reader ──────────────────────────────────────────────────────────────

/**
 * Excel format (one row per shop, row 1 is header and is skipped):
 *  Col A: app_shop_id
 *  Col B: Monday    ("HH:MM-HH:MM" or "closed")
 *  Col C: Tuesday
 *  Col D: Wednesday
 *  Col E: Thursday
 *  Col F: Friday
 *  Col G: Saturday
 *  Col H: Sunday
 */
async function readExcel(filePath: string): Promise<ShopSchedule[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const rows: ShopSchedule[] = [];

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const shopId = String(row.getCell(1).value ?? '').trim();
    if (!shopId) return;

    // Parse each day (cols B-H = days 1-7)
    const dayBizTime: (BizTimeRange[] | null)[] = [];
    for (let col = 2; col <= 8; col++) {
      const raw = String(row.getCell(col).value ?? '').trim();
      if (isClosed(raw)) {
        dayBizTime.push(null);
      } else {
        try {
          const buffered = applyBuffer(parseScheduleString(raw));
          dayBizTime.push(buffered.map(r => ({ begin: minutesToHHMM(r.begin), end: minutesToHHMM(r.end) })));
        } catch {
          logger.warn(`Row ${rowNum}: invalid schedule "${raw}" for shop ${shopId} col ${col} — treating as closed`);
          dayBizTime.push(null);
        }
      }
    }

    // Group days that share the same schedule
    const groupMap = new Map<string, { bizDay: number[]; bizTime: BizTimeRange[] }>();
    for (let i = 0; i < 7; i++) {
      const bizTime = dayBizTime[i];
      if (!bizTime) continue;
      const key = JSON.stringify(bizTime);
      if (!groupMap.has(key)) {
        groupMap.set(key, { bizDay: [i + 1], bizTime });
      } else {
        groupMap.get(key)!.bizDay.push(i + 1);
      }
    }

    const dayGroups = Array.from(groupMap.values());
    if (dayGroups.length > 0) {
      rows.push({ appShopId: shopId, dayGroups });
    }
  });

  return rows;
}

// ── DiDi API call ─────────────────────────────────────────────────────────────

async function updateShopSchedule(
  token: string,
  shop: ShopSchedule,
): Promise<void> {
  const payload = {
    auth_token: token,
    app_shop_id: shop.appShopId,
    biz_day_time: shop.dayGroups.map(g => ({
      bizDay: g.bizDay,
      bizTime: g.bizTime,
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

async function scheduleUpdatePermanent(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand)             throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const tempFile = ctx.field('Excel File');
  if (!tempFile)          throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);
  let shops: ShopSchedule[] = [];

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

  logger.log(`Processing ${shops.length} shops for brand=${brand.brandName} (${brand.country})`);

  const failed: { appShopId: string; error: string }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        const token = await getAuthToken(appId, appSecret, shop.appShopId);
        await updateShopSchedule(token, shop);
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

  await unlink(filePath).catch(() => undefined);

  if (failed.length === shops.length) {
    throw new Error(`All ${shops.length} shops failed — see notes for details`);
  }

  const ok = shops.length - failed.length;
  logger.log(`Done: ${ok} ok, ${failed.length} failed`);

  return { total: shops.length, success: ok, failed: failed.length, failedShops: failed };
}

registerHandler('schedule_update_permanent', scheduleUpdatePermanent);
