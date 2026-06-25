import { Logger } from '@nestjs/common';
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';
import { registerHandler, HandlerContext } from '../handler.processor';
import {
  DIDI_BASE, BATCH_SIZE, COOLDOWN_BATCH_MS,
  sleep, parseJsonKeepingIds,
  isRawShopId, fetchShopIdMap, getAuthToken,
} from './didi-food.util';

const logger = new Logger('menu_upload');
const ITEMS_PER_CATEGORY = 4000;

interface MenuItem {
  upc: string;
  price: number;
  discount: number;
}

interface ShopMenu {
  appShopId: string;
  items: MenuItem[];
}

// ── Price helpers ─────────────────────────────────────────────────────────────

function processPriceMX(price: number): number {
  const s = String(price).replace(',', '.');
  const [, decimals = ''] = s.split('.');
  if (decimals.length > 2) {
    throw new Error(`Invalid MX price ${price}: max 2 decimal places allowed`);
  }
  return Math.round(parseFloat(s) * 100);
}

function processPriceCOCR(price: number): number {
  const s = String(price);
  if (s.includes('.') || s.includes(',')) {
    throw new Error(`Invalid CO/CR price ${price}: decimals not allowed`);
  }
  return Math.round(price * 100);
}

function toApiPrice(price: number, country: string): number {
  return country === 'MX' ? processPriceMX(price) : processPriceCOCR(price);
}

// ── Excel reader ──────────────────────────────────────────────────────────────

/**
 * Excel format (row 1 is header, skipped):
 *  Col A: app_shop_id (or raw shop_id starting with 57, length 19)
 *  Col B: UPC
 *  Col C: Precio
 *  Col D: Descuento (optional, 0 if absent)
 *
 * Rows are grouped by shop — each shop can have different products and prices.
 */
async function readExcel(filePath: string): Promise<ShopMenu[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const shopMap = new Map<string, MenuItem[]>();

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const shopId = String(row.getCell(1).value ?? '').trim();
    const upc    = String(row.getCell(2).value ?? '').trim();
    if (!shopId || !upc) return;

    const price    = parseFloat(String(row.getCell(3).value ?? '0').replace(',', '.')) || 0;
    const discount = parseFloat(String(row.getCell(4).value ?? '0').replace(',', '.')) || 0;

    if (!shopMap.has(shopId)) shopMap.set(shopId, []);
    shopMap.get(shopId)!.push({ upc, price, discount });
  });

  return Array.from(shopMap.entries()).map(([appShopId, items]) => ({ appShopId, items }));
}

// ── Payload builder ───────────────────────────────────────────────────────────

function buildMenuPayload(authToken: string, items: MenuItem[], country: string) {
  const ts = Date.now();
  const categoryIds: string[] = [];
  const categories: object[] = [];
  const apiItems: Record<string, unknown>[] = [];

  // Split items into categories of max ITEMS_PER_CATEGORY each
  for (let i = 0; i * ITEMS_PER_CATEGORY < items.length; i++) {
    const slice = items.slice(i * ITEMS_PER_CATEGORY, (i + 1) * ITEMS_PER_CATEGORY);
    const catId = `category_${i}`;
    categoryIds.push(catId);
    categories.push({
      app_category_id: catId,
      category_name: 'Despensa',
      app_item_ids: slice.map(it => it.upc),
    });
  }

  for (const it of items) {
    const price    = toApiPrice(it.price, country);
    const discount = it.discount > 0 ? toApiPrice(it.discount, country) : undefined;
    const entry: Record<string, unknown> = {
      item_name: `Producto ${it.upc}`,
      upc: it.upc,
      price,
      status: 1,
      app_item_id: it.upc,
    };
    if (discount !== undefined) entry.activity_price = discount;
    apiItems.push(entry);
  }

  return {
    auth_token: authToken,
    menus: [{ menu_name: `Menu_${ts}`, app_menu_id: `menu_${ts}`, app_category_ids: categoryIds }],
    categories,
    items: apiItems,
    merge_policy: 1,
  };
}

// ── DiDi API call ─────────────────────────────────────────────────────────────

async function uploadMenuForShop(token: string, items: MenuItem[], country: string): Promise<string> {
  const payload = buildMenuPayload(token, items, country);
  const res = await fetch(`${DIDI_BASE}/v3/item/item/uploadGrocery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = parseJsonKeepingIds(await res.text());
  if (body.errno !== 0) throw new Error(`DiDi error (errno=${body.errno}): ${body.errmsg}`);
  return String(body.data?.taskID ?? '');
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function menuUpload(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand)             throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const tempFile = ctx.field('Excel File');
  if (!tempFile)          throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);
  let shops: ShopMenu[] = [];

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

  if (isRawShopId(shops[0].appShopId)) {
    logger.log('Detected raw shop_ids — fetching shop list from DiDi...');
    const shopIdMap = await fetchShopIdMap(appId, appSecret);
    const unmapped: string[] = [];
    for (const shop of shops) {
      const mapped = shopIdMap.get(shop.appShopId);
      if (mapped) shop.appShopId = mapped;
      else unmapped.push(shop.appShopId);
    }
    if (unmapped.length) {
      unmapped.forEach(id => ctx.addNote(`✗ shop_id ${id}: not found in DiDi shop list`));
    }
    shops = shops.filter(s => !isRawShopId(s.appShopId));
    if (shops.length === 0) {
      await unlink(filePath).catch(() => undefined);
      throw new Error('No shops could be mapped from shop_id to app_shop_id');
    }
  }

  logger.log(`Uploading menu to ${shops.length} shops for brand=${brand.brandName} (${brand.country})`);

  const failed:     { appShopId: string; error: string }[] = [];
  const successful: { appShopId: string; taskId: string; items: number }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        const token  = await getAuthToken(appId, appSecret, shop.appShopId);
        const taskId = await uploadMenuForShop(token, shop.items, brand.country);
        successful.push({ appShopId: shop.appShopId, taskId, items: shop.items.length });
        ctx.addNote(`✓ ${shop.appShopId}: taskID=${taskId} (${shop.items.length} items)`);
        logger.log(`✓ ${shop.appShopId}: taskID=${taskId}`);
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(`✗ ${shop.appShopId}: ${msg}`);
        failed.push({ appShopId: shop.appShopId, error: msg });
        ctx.addNote(`✗ ${shop.appShopId}: ${msg}`);
      }
    }

    if (i + BATCH_SIZE < shops.length) await sleep(COOLDOWN_BATCH_MS);
  }

  if (failed.length > 0) {
    await ctx.sendAlert({
      text: `⚠️ menu_upload — ${failed.length}/${shops.length} shops failed for **${brand.brandName}** (${brand.country})`,
      attachments: [{ title: 'Failed shops', text: failed.map(f => `• ${f.appShopId}: ${f.error}`).join('\n'), color: '#F44336' }],
    });
  }

  const allFailed = failed.length === shops.length;
  if (!allFailed || ctx.isLastAttempt) await unlink(filePath).catch(() => undefined);
  if (allFailed) throw new Error(`All ${shops.length} shops failed — see notes for details`);

  const ok = shops.length - failed.length;
  logger.log(`Done: ${ok} ok, ${failed.length} failed`);
  return { total: shops.length, success: ok, failed: failed.length, successfulShops: successful, failedShops: failed };
}

registerHandler('menu_upload', menuUpload);
