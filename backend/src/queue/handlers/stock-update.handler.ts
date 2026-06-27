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

const logger = new Logger('stock_update');

interface StockItem {
  upc: string;
  stock: number;
}

interface ShopStock {
  appShopId: string;
  items: StockItem[];
}

// ── Excel reader ──────────────────────────────────────────────────────────────

/**
 * Excel format (row 1 is header, skipped):
 *  Col A: app_shop_id (or raw shop_id starting with 57, length 19)
 *  Col B: UPC
 *  Col C: Stock
 *
 * Rows are grouped by shop — each shop can have different stock levels per product.
 */
async function readExcel(filePath: string): Promise<ShopStock[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const shopMap = new Map<string, StockItem[]>();

  sheet.eachRow((row: ExcelJS.Row, rowNum: number) => {
    if (rowNum === 1) return;
    const shopId = String(row.getCell(1).value ?? '').trim();
    const upc    = String(row.getCell(2).value ?? '').trim();
    if (!shopId || !upc) return;

    const stock = parseInt(String(row.getCell(3).value ?? '0')) || 0;

    if (!shopMap.has(shopId)) shopMap.set(shopId, []);
    shopMap.get(shopId)!.push({ upc, stock });
  });

  return Array.from(shopMap.entries()).map(([appShopId, items]) => ({ appShopId, items }));
}

// ── DiDi API call ─────────────────────────────────────────────────────────────

async function updateStockForShop(token: string, items: StockItem[]): Promise<void> {
  const payload = {
    auth_token: token,
    stock_list: items.map(it => ({ app_item_id: it.upc, stock: it.stock })),
  };
  const res = await fetch(`${DIDI_BASE}/v1/item/item/setStock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = parseJsonKeepingIds(await res.text());
  if (body.errno !== 0) throw new Error(`DiDi error (errno=${body.errno}): ${body.errmsg}`);
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function stockUpdate(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand)             throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const tempFile = ctx.field('Excel File');
  if (!tempFile)          throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);
  let shops: ShopStock[] = [];

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

  logger.log(`Updating stock for ${shops.length} shops, brand=${brand.brandName}`);

  const failed:     { appShopId: string; error: string }[] = [];
  const successful: { appShopId: string; items: number }[] = [];

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);

    for (const shop of batch) {
      try {
        const token = await getAuthToken(appId, appSecret, shop.appShopId);
        await updateStockForShop(token, shop.items);
        successful.push({ appShopId: shop.appShopId, items: shop.items.length });
        ctx.addNote(`✓ ${shop.appShopId}: ${shop.items.length} items updated`);
        logger.log(`✓ ${shop.appShopId}: ${shop.items.length} items`);
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
      text: `⚠️ stock_update — ${failed.length}/${shops.length} shops failed for **${brand.brandName}** (${brand.country})`,
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

registerHandler('stock_update', stockUpdate);
