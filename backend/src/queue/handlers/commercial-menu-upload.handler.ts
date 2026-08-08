import { Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { uploadGroceryBatch } from '../../file-integrations/grocery-menu-upload.util';
import { FlatGroceryUpload } from '../../file-integrations/grocery-destination-menu.util';
import { HandlerContext, registerHandler } from '../handler.processor';
import { getAuthToken } from './didi-food.util';

const logger = new Logger('commercial_menu_upload');
const MAX_ITEMS = 3000;
const SHOP_CONCURRENCY = 5;

interface CommercialItem {
  categoryId: string;
  upc: string;
  price: number;
  activityPrice?: number;
  imageUrl: string;
  name?: string;
}

function normalizeHeader(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cellText(cell: ExcelJS.Cell) {
  return cell.text?.trim() ?? String(cell.value ?? '').trim();
}

function priceToCents(value: number, country: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error('price must be zero or greater');
  if (country !== 'MX' && !Number.isInteger(value)) throw new Error(`${country} prices cannot contain decimals`);
  const decimalPlaces = (String(value).split('.')[1] ?? '').length;
  if (country === 'MX' && decimalPlaces > 2) throw new Error('MX prices accept at most two decimals');
  return Math.round(value * 100);
}

async function readCommercialWorkbook(filePath: string): Promise<CommercialItem[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('Items');
  if (!sheet) throw new Error('Worksheet "Items" was not found; download a fresh template from the task');

  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalizeHeader(cell.value), column));
  const column = (name: string) => headers.get(normalizeHeader(name));
  const required = ['category_id', 'UPC_SKU', 'price', 'image_url'];
  const missing = required.filter(name => !column(name));
  if (missing.length) throw new Error(`Items worksheet is missing columns: ${missing.join(', ')}`);

  const items: CommercialItem[] = [];
  const upcs = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const categoryId = cellText(row.getCell(column('category_id')!));
    const upc = cellText(row.getCell(column('UPC_SKU')!));
    const rawPrice = cellText(row.getCell(column('price')!)).replace(',', '.');
    const imageUrl = cellText(row.getCell(column('image_url')!));
    const activityText = column('activity_price') ? cellText(row.getCell(column('activity_price')!)).replace(',', '.') : '';
    const name = column('item_name_optional') ? cellText(row.getCell(column('item_name_optional')!)) : '';
    if (!categoryId && !upc && !rawPrice && !imageUrl && !activityText && !name) continue;
    if (!categoryId || !upc || !rawPrice || !imageUrl) {
      throw new Error(`Items row ${rowNumber}: category_id, UPC_SKU, price and image_url are required`);
    }
    if (upcs.has(upc)) throw new Error(`Items row ${rowNumber}: UPC/SKU ${upc} is repeated`);
    if (!/^https:\/\//i.test(imageUrl)) throw new Error(`Items row ${rowNumber}: image_url must be a public HTTPS URL`);
    const price = Number(rawPrice);
    const activityPrice = activityText ? Number(activityText) : undefined;
    if (!Number.isFinite(price) || price < 0) throw new Error(`Items row ${rowNumber}: price must be zero or greater`);
    if (activityPrice !== undefined && (!Number.isFinite(activityPrice) || activityPrice < 0 || activityPrice > price)) {
      throw new Error(`Items row ${rowNumber}: activity_price must be between zero and price`);
    }
    upcs.add(upc);
    items.push({ categoryId, upc, price, activityPrice, imageUrl, name: name || undefined });
  }
  if (!items.length) throw new Error('Items worksheet has no products');
  if (items.length > MAX_ITEMS) throw new Error(`A task accepts up to ${MAX_ITEMS} unique items; received ${items.length}`);
  return items;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

async function commercialMenuUpload(ctx: HandlerContext) {
  if (!ctx.brand) throw new Error('Task has no brand linked');
  if (!ctx.brand.application) throw new Error(`Brand ${ctx.brand.brandName} has no linked application`);
  if (!ctx.targetShops.length) throw new Error('Task has no target stores');
  if (!ctx.menuCategories.length) throw new Error('Brand has no active menu categories');
  const tempFile = ctx.field('Excel File');
  if (!tempFile) throw new Error('Form field "Excel File" is required');
  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);

  let items: CommercialItem[];
  try {
    items = await readCommercialWorkbook(filePath);
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }

  const categoryMap = new Map(ctx.menuCategories.map(category => [category.categoryId, category]));
  for (const item of items) {
    if (!categoryMap.has(item.categoryId)) {
      await unlink(filePath).catch(() => undefined);
      throw new Error(`Category ${item.categoryId} is not active for ${ctx.brand.brandName}; download a fresh template`);
    }
  }

  const catalog = new Map<string, { name: string; imageUrl: string | null }>();
  await ctx.forEachBrandItemBatch(batch => {
    batch.forEach(item => {
      if (item.upc) catalog.set(item.upc, { name: item.name, imageUrl: item.imageUrl });
      catalog.set(item.appItemId, { name: item.name, imageUrl: item.imageUrl });
    });
  });

  const apiItems = items.map(item => {
    const known = catalog.get(item.upc);
    const output: Record<string, unknown> = {
      app_item_id: item.upc,
      upc: item.upc,
      item_name: item.name || known?.name || item.upc,
      price: priceToCents(item.price, ctx.brand!.country),
      status: 1,
      head_img: item.imageUrl,
    };
    if (item.activityPrice !== undefined) output.activity_price = priceToCents(item.activityPrice, ctx.brand!.country);
    return output;
  });
  const usedCategoryIds = ctx.menuCategories
    .filter(category => items.some(item => item.categoryId === category.categoryId))
    .map(category => category.categoryId);
  const upload: FlatGroceryUpload = {
    menus: [{
      app_menu_id: `commercial_${ctx.taskId.replace(/-/g, '').slice(0, 20)}`,
      menu_name: `Commercial ${ctx.brand.brandName}`,
      app_category_ids: usedCategoryIds,
    }],
    categories: ctx.menuCategories
      .filter(category => usedCategoryIds.includes(category.categoryId))
      .map(category => ({
        app_category_id: category.categoryId,
        category_name: category.name,
        app_item_ids: items.filter(item => item.categoryId === category.categoryId).map(item => item.upc),
      })),
    items: apiItems,
    categoryIds: usedCategoryIds,
  };
  const mergePolicy = ctx.field('Upload Mode') === 'Replace' ? 1 : 0;
  const { appId, appSecret } = ctx.brand.application;

  const results = await mapWithConcurrency(ctx.targetShops, SHOP_CONCURRENCY, async shop => {
    try {
      const authToken = await getAuthToken(appId, appSecret, shop.appShopId);
      const response = await uploadGroceryBatch(
        authToken,
        upload,
        'uploadGrocery',
        mergePolicy,
        async () => undefined,
        () => getAuthToken(appId, appSecret, shop.appShopId),
      );
      const result = { shopId: shop.shopId, appShopId: shop.appShopId, status: 'accepted', taskId: response.referenceId, items: items.length };
      ctx.addNote(`OK ${shop.shopId} (${shop.appShopId}): accepted ${items.length} items, DiDi task ${response.referenceId}`);
      return result;
    } catch (error) {
      const message = (error as Error).message;
      logger.warn(`${shop.shopId} failed: ${message}`);
      ctx.addNote(`FAILED ${shop.shopId} (${shop.appShopId}): ${message}`);
      return { shopId: shop.shopId, appShopId: shop.appShopId, status: 'failed', error: message };
    }
  });

  const failed = results.filter(result => result.status === 'failed');
  const successful = results.length - failed.length;
  if (!failed.length || ctx.isLastAttempt || successful > 0) await unlink(filePath).catch(() => undefined);
  if (!successful) throw new Error(`Upload failed for all ${results.length} target stores`);
  if (failed.length) {
    await ctx.sendAlert({
      text: `Commercial menu upload partially completed for ${ctx.brand.brandName}: ${successful}/${results.length} stores accepted.`,
      attachments: [{ title: 'Failed stores', text: failed.slice(0, 50).map(result => `${result.shopId}: ${'error' in result ? result.error : 'Unknown error'}`).join('\n'), color: '#F59E0B' }],
    });
  }
  ctx.addNote(`Summary: ${successful} accepted, ${failed.length} failed, ${items.length} items per store.`);
  return { totalStores: results.length, acceptedStores: successful, failedStores: failed.length, itemsPerStore: items.length, mergePolicy, results };
}

registerHandler('commercial_menu_upload', commercialMenuUpload);
