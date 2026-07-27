import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import * as Exceljs from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE,
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  COOLDOWN_SHOPLIST_MS,
  generateSignature,
  parseJsonKeepingIds,
  getAuthToken,
  sleep,
} from './didi-food.util';

const logger = new Logger('export_shop_list');

const HEADERS = [
  'Shop ID', 'App Shop ID', 'Nombre', 'Address', 'POI Name',
  'Ciudad', 'Latitud', 'Longitud', 'KA Type', 'Operations Category',
  'Horario Monday', 'Horario Tuesday', 'Horario Wednesday',
  'Horario Thursday', 'Horario Friday', 'Horario Saturday', 'Horario Sunday',
];

const DAY_MAP: Record<number, keyof ScheduleByDay> = {
  1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday',
  5: 'friday', 6: 'saturday', 7: 'sunday',
};

interface ScheduleByDay {
  monday: string; tuesday: string; wednesday: string; thursday: string;
  friday: string; saturday: string; sunday: string;
}

function formatSchedule(bizDayTime: { biz_day: number[]; biz_time: { begin: string; end: string }[] }[]): ScheduleByDay {
  const s: ScheduleByDay = { monday: '', tuesday: '', wednesday: '', thursday: '', friday: '', saturday: '', sunday: '' };
  for (const period of bizDayTime ?? []) {
    const hours = (period.biz_time ?? []).map(t => `${t.begin}-${t.end}`).join(', ');
    for (const dayNum of period.biz_day ?? []) {
      const key = DAY_MAP[dayNum];
      if (key) s[key] = s[key] ? `${s[key]}; ${hours}` : hours;
    }
  }
  return s;
}

interface BasicShop { shopId: string; appShopId: string }

async function fetchAllShopsBasic(appId: string, appSecret: string, onPage: (n: number, total: number) => void): Promise<BasicShop[]> {
  const pageSize = 100;
  const all: BasicShop[] = [];
  let pageNo = 1;
  let totalKnown = Infinity;
  let rateLimitRetries = 0;

  while (all.length < totalKnown) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params: Record<string, string | number> = { app_id: appId, page_no: pageNo, page_size: pageSize, timestamp };
    params.sign = generateSignature(params, appSecret);

    const res = await fetch(`${DIDI_BASE}/v1/shop/shop/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!res.ok) throw new Error(`DiDi shop list HTTP error: ${res.status}`);
    const body = parseJsonKeepingIds(await res.text());

    if (body.errno === 10005) {
      rateLimitRetries++;
      if (rateLimitRetries > 3) throw new Error(`DiDi shop list rate limit persisted on page ${pageNo}`);
      await sleep(COOLDOWN_SHOPLIST_MS);
      continue;
    }
    rateLimitRetries = 0;
    if (body.errno !== 0) {
      throw new Error(`DiDi shop list failed (page ${pageNo}): ${body.errmsg} (errno=${body.errno})`);
    }

    const shops: { shop_id: string; app_shop_id: string }[] = body.data?.shop_list ?? [];
    totalKnown = body.data?.total ?? 0;
    for (const s of shops) {
      all.push({ shopId: String(s.shop_id), appShopId: String(s.app_shop_id) });
    }

    onPage(pageNo, Math.ceil(totalKnown / pageSize));

    if (shops.length < pageSize) break;
    pageNo++;
    await sleep(COOLDOWN_SHOPLIST_MS);
  }

  return all;
}

async function exportShopList(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand) throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const { appId, appSecret } = brand.application;
  const kaType = brand.kaType ?? '';
  const category = brand.category ?? '';

  // ── 1. Fetch shop list ────────────────────────────────────────────────────
  ctx.addNote(`Fetching shop list for ${brand.brandName}…`);
  const shops = await fetchAllShopsBasic(appId, appSecret, (page, total) => {
    logger.log(`Shop list page ${page}/${total}`);
  });
  ctx.addNote(`${shops.length} shops found. Fetching details…`);
  logger.log(`${brand.brandName}: ${shops.length} shops`);

  // ── 2. Fetch details in batches ───────────────────────────────────────────
  const rows: (string | number)[][] = [];
  const totalBatches = Math.ceil(shops.length / BATCH_SIZE);

  for (let bi = 0; bi < totalBatches; bi++) {
    const batch = shops.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);

    // Get auth tokens concurrently
    const tokenResults = await Promise.allSettled(
      batch.map(s => getAuthToken(appId, appSecret, s.appShopId)),
    );

    // Get shop details concurrently
    const detailResults = await Promise.allSettled(
      tokenResults.map(async (tr, i) => {
        if (tr.status === 'rejected') throw tr.reason;
        const res = await fetch(`${DIDI_BASE}/v1/shop/shop/detail?auth_token=${encodeURIComponent(tr.value)}`);
        if (!res.ok) throw new Error(`DiDi shop detail HTTP error: ${res.status}`);
        return parseJsonKeepingIds(await res.text());
      }),
    );

    for (let i = 0; i < batch.length; i++) {
      const shop = batch[i];
      const dr = detailResults[i];
      if (dr.status === 'rejected' || dr.value?.errno !== 0 || !dr.value?.data) {
        const reason = dr.status === 'rejected' ? (dr.reason as Error).message : `errno=${dr.value?.errno} ${dr.value?.errmsg}`;
        logger.warn(`Detail failed for ${shop.appShopId}: ${reason}`);
        ctx.addNote(`⚠ ${shop.appShopId}: ${reason}`);
        continue;
      }
      const d = dr.value.data;
      const sched = formatSchedule(d.biz_day_time ?? []);
      rows.push([
        shop.shopId, shop.appShopId,
        d.name ?? '', d.addr ?? '', d.poi_name ?? '',
        '', // city — no mapping available in this context
        d.lat ?? '', d.lng ?? '',
        kaType, category,
        sched.monday, sched.tuesday, sched.wednesday, sched.thursday,
        sched.friday, sched.saturday, sched.sunday,
      ]);
    }

    logger.log(`Batch ${bi + 1}/${totalBatches} done (${rows.length} rows so far)`);
    if (bi < totalBatches - 1) await sleep(COOLDOWN_BATCH_MS);
  }

  ctx.addNote(`Details fetched: ${rows.length}/${shops.length} shops. Building file…`);

  if (shops.length > 0 && rows.length === 0) {
    throw new Error('Could not fetch details for any shop; export file was not generated');
  }

  // ── 3. Build .xlsx ────────────────────────────────────────────────────────
  const wb = new Exceljs.Workbook();
  const ws = wb.addWorksheet('Tiendas');

  const headerRow = ws.addRow(HEADERS);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
  headerRow.alignment = { vertical: 'middle' };

  // Force text format on Shop ID (col 1) and App Shop ID (col 2) to prevent numeric conversion
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(2).numFmt = '@';

  for (const row of rows) ws.addRow(row);

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach(col => {
    let maxLen = 10;
    col.eachCell?.({ includeEmpty: false }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 50);
  });

  // ── 4. Save to disk ───────────────────────────────────────────────────────
  const exportsDir = join(process.cwd(), 'uploads', 'exports');
  await mkdir(exportsDir, { recursive: true });
  const filename = `shops-${randomUUID()}.xlsx`;
  await wb.xlsx.writeFile(join(exportsDir, filename));

  logger.log(`Saved: ${filename} (${rows.length} rows)`);
  ctx.addNote(`✅ ${rows.length} tiendas exportadas`);

  return { fileKey: filename, totalShops: rows.length, brand: brand.brandName };
}

registerHandler('export_shop_list', exportShopList);
