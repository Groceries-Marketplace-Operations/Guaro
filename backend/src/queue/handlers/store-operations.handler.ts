import { Logger } from '@nestjs/common';
import { DayOfWeek, ShopPickingModel } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { join } from 'path';
import { registerHandler, HandlerContext } from '../handler.processor';
import { downloadMenu } from '../../integrations/auto-turn-off-api.util';
import {
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  isRawShopId,
  isClosed,
  parseJsonKeepingIds,
  parseScheduleString,
  sleep,
} from './didi-food.util';

const logger = new Logger('store_operations');

const SHOP_DAY_COLUMNS: Array<{ header: string; day: DayOfWeek }> = [
  { header: 'monday', day: DayOfWeek.monday },
  { header: 'tuesday', day: DayOfWeek.tuesday },
  { header: 'wednesday', day: DayOfWeek.wednesday },
  { header: 'thursday', day: DayOfWeek.thursday },
  { header: 'friday', day: DayOfWeek.friday },
  { header: 'saturday', day: DayOfWeek.saturday },
  { header: 'sunday', day: DayOfWeek.sunday },
];

function normalizedHeader(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cellText(row: ExcelJS.Row, column: number) {
  return row.getCell(column).text?.trim() ?? String(row.getCell(column).value ?? '').trim();
}

function clock(minutes: number) {
  const normalized = minutes === 1440 ? 0 : minutes;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function parseCashBlock(value: string) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`driver_cash_blocked must be TRUE or FALSE, received "${value}"`);
}

function parsePickingModel(value: string): ShopPickingModel {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, ShopPickingModel> = {
    store_picking: ShopPickingModel.store_picking,
    storepicking: ShopPickingModel.store_picking,
    qr_code_2in1: ShopPickingModel.qr_code_2in1,
    qrcode2in1: ShopPickingModel.qr_code_2in1,
    prepaid_card_2in1: ShopPickingModel.prepaid_card_2in1,
    prepaidcard2in1: ShopPickingModel.prepaid_card_2in1,
  };
  const model = aliases[normalized] ?? aliases[normalized.replace(/_/g, '')];
  if (!model) throw new Error(`Unknown picking_model "${value}"`);
  return model;
}

function ids(value: string | null): string[] {
  return [...new Set((value ?? '')
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(Boolean))];
}

function requireBrand(ctx: HandlerContext) {
  if (!ctx.brand) throw new Error('Task has no brand linked');
  if (!ctx.brand.application) throw new Error(`Brand ${ctx.brand.brandName} has no linked application`);
  return { brand: ctx.brand, application: ctx.brand.application };
}

async function resolveTargets(ctx: HandlerContext, label = 'Target Shop IDs') {
  const { application } = requireBrand(ctx);
  const requested = ids(ctx.field(label));
  if (!requested.length) throw new Error(`Form field "${label}" must contain at least one shop_id`);
  const rawIds = requested.filter(isRawShopId);
  const map = rawIds.length
    ? await fetchShopIdMap(application.appId, application.appSecret, rawIds)
    : new Map<string, string>();
  const resolved = requested.flatMap(shopId => {
    const appShopId = isRawShopId(shopId) ? map.get(shopId) : shopId;
    return appShopId ? [{ shopId, appShopId }] : [];
  });
  const missing = requested.filter(shopId => isRawShopId(shopId) && !map.has(shopId));
  return { requested, resolved, missing };
}

async function postShopUpdate(authToken: string, data: Record<string, unknown>) {
  const endpoint = 'POST /v1/shop/shop/update';
  const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken, ...data }),
  });
  const body = parseJsonKeepingIds(await response.text());
  if (!response.ok || body.errno !== 0) {
    throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
  }
  return body.data ?? {};
}

async function updateShopHeadImage(ctx: HandlerContext) {
  const { brand, application } = requireBrand(ctx);
  const imageKey = ctx.field('Shop Head Image');
  if (!imageKey || !/^[a-f0-9-]+\.(?:jpe?g|png)$/i.test(imageKey)) {
    throw new Error('A valid Shop Head Image upload is required');
  }
  const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173/guaro').replace(/\/$/, '');
  const imageUrl = `${frontendUrl}/api/uploads/task-assets/${encodeURIComponent(imageKey)}`;
  const { requested, resolved, missing } = await resolveTargets(ctx);
  const successful: string[] = [];
  const failed = missing.map(shopId => ({ shopId, error: 'shop_id not found in POST /v1/shop/shop/list' }));

  for (let offset = 0; offset < resolved.length; offset += BATCH_SIZE) {
    for (const target of resolved.slice(offset, offset + BATCH_SIZE)) {
      try {
        const token = await getAuthToken(application.appId, application.appSecret, target.appShopId);
        await postShopUpdate(token, { shop_head_img: imageUrl });
        successful.push(target.shopId);
        ctx.addNote(`✓ ${target.shopId}: shop_head_img updated`);
      } catch (error) {
        const message = (error as Error).message;
        failed.push({ shopId: target.shopId, error: message });
        ctx.addNote(`✗ ${target.shopId}: ${message}`);
      }
    }
    if (offset + BATCH_SIZE < resolved.length) await sleep(COOLDOWN_BATCH_MS);
  }
  if (!successful.length) throw new Error(`No store image was updated (${failed.length}/${requested.length} failed)`);
  logger.log(`Updated shop_head_img for ${successful.length}/${requested.length} shops of ${brand.brandName}`);
  return { imageUrl, total: requested.length, success: successful.length, failed: failed.length, successful, failures: failed };
}

async function uploadMenu(authToken: string, menu: Record<string, unknown>, mergePolicy: number) {
  const endpoint = 'POST /v3/item/item/uploadGrocery';
  const payload: Record<string, unknown> = {
    auth_token: authToken,
    menus: Array.isArray(menu.menus) ? menu.menus : [],
    categories: Array.isArray(menu.categories) ? menu.categories : [],
    items: Array.isArray(menu.items) ? menu.items : [],
    merge_policy: mergePolicy,
  };
  if (Array.isArray(menu.modifier_groups) && menu.modifier_groups.length) {
    payload.modifier_groups = menu.modifier_groups;
  }
  const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v3/item/item/uploadGrocery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = parseJsonKeepingIds(await response.text());
  if (!response.ok || body.errno !== 0) {
    throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
  }
  return String(body.data?.taskID ?? body.data?.taskId ?? '');
}

async function replicateStoreMenu(ctx: HandlerContext) {
  const { brand, application } = requireBrand(ctx);
  const sourceInput = ctx.field('Reference Shop ID')?.trim();
  if (!sourceInput) throw new Error('Reference Shop ID is required');
  const sourceMap = isRawShopId(sourceInput)
    ? await fetchShopIdMap(application.appId, application.appSecret, [sourceInput])
    : new Map<string, string>();
  const sourceAppShopId = isRawShopId(sourceInput) ? sourceMap.get(sourceInput) : sourceInput;
  if (!sourceAppShopId) throw new Error(`Reference shop ${sourceInput} was not found in POST /v1/shop/shop/list`);

  const sourceToken = await getAuthToken(application.appId, application.appSecret, sourceAppShopId);
  ctx.addNote(`Downloading reference menu from ${sourceInput}…`);
  const downloaded = await downloadMenu(sourceToken, async () => undefined);
  const menu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
  const mergePolicy = ctx.field('Merge Policy') === 'Merge' ? 0 : 1;
  const { requested, resolved, missing } = await resolveTargets(ctx);
  const successful: Array<{ shopId: string; taskId: string }> = [];
  const failed = missing.map(shopId => ({ shopId, error: 'shop_id not found in POST /v1/shop/shop/list' }));

  for (let offset = 0; offset < resolved.length; offset += BATCH_SIZE) {
    for (const target of resolved.slice(offset, offset + BATCH_SIZE)) {
      if (target.appShopId === sourceAppShopId) {
        failed.push({ shopId: target.shopId, error: 'Target cannot be the reference store' });
        continue;
      }
      try {
        const token = await getAuthToken(application.appId, application.appSecret, target.appShopId);
        const taskId = await uploadMenu(token, menu, mergePolicy);
        successful.push({ shopId: target.shopId, taskId });
        ctx.addNote(`✓ ${target.shopId}: upload taskID=${taskId || 'accepted'}`);
      } catch (error) {
        const message = (error as Error).message;
        failed.push({ shopId: target.shopId, error: message });
        ctx.addNote(`✗ ${target.shopId}: ${message}`);
      }
    }
    if (offset + BATCH_SIZE < resolved.length) await sleep(COOLDOWN_BATCH_MS);
  }
  if (!successful.length) throw new Error(`Menu replication failed for all ${requested.length} target shops`);
  logger.log(`Replicated ${downloaded.items.length} items from ${sourceInput} to ${successful.length} shops of ${brand.brandName}`);
  return {
    referenceShopId: sourceInput, menuTaskId: downloaded.taskId, items: downloaded.items.length,
    total: requested.length, success: successful.length, failed: failed.length, successful, failures: failed,
  };
}

async function checkShopIntegration(ctx: HandlerContext) {
  const { application } = requireBrand(ctx);
  const requested = ids(ctx.field('Target Shop IDs'));
  if (!requested.length) throw new Error('Target Shop IDs is required');
  const rawShopIds = requested.filter(isRawShopId);
  const map = rawShopIds.length
    ? await fetchShopIdMap(application.appId, application.appSecret, rawShopIds)
    : new Map<string, string>();
  const integrated: Array<{ shopId: string; appShopId: string; integrated: true }> = requested.flatMap(shopId => {
    const appShopId = isRawShopId(shopId) ? map.get(shopId) : undefined;
    return appShopId ? [{ shopId, appShopId, integrated: true }] : [];
  });
  for (const appShopId of requested.filter(value => !isRawShopId(value))) {
    try {
      await getAuthToken(application.appId, application.appSecret, appShopId);
      integrated.push({ shopId: appShopId, appShopId, integrated: true });
    } catch (error) {
      ctx.addNote(`✗ ${appShopId}: ${(error as Error).message}`);
    }
  }
  const notIntegrated = requested.filter(shopId => !integrated.some(value => value.shopId === shopId));
  integrated.forEach(value => ctx.addNote(`✓ ${value.shopId}: integrated as ${value.appShopId}`));
  notIntegrated.forEach(shopId => ctx.addNote(`✗ ${shopId}: not returned by POST /v1/shop/shop/list`));
  return { total: requested.length, integrated: integrated.length, notIntegrated: notIntegrated.length, shops: integrated, missingShopIds: notIntegrated };
}

async function addShopsToIntegration(ctx: HandlerContext) {
  if (!ctx.brand) throw new Error('Task has no brand linked');
  const fileKey = ctx.field('Shop Integration Excel');
  if (!fileKey || !/^[a-f0-9-]+\.xlsx$/i.test(fileKey)) throw new Error('A validated Shop Integration Excel file is required');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(process.cwd(), 'uploads', 'temp', fileKey));
  const sheet = workbook.getWorksheet('Shops') ?? workbook.worksheets[0];
  if (!sheet) throw new Error('The Excel workbook has no Shops worksheet');

  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => columns.set(normalizedHeader(cell.text), column));
  const required = ['shopid', 'appshopid', 'pickingmodel', ...SHOP_DAY_COLUMNS.map(item => item.header)];
  const missingHeaders = required.filter(header => !columns.has(header));
  if (missingHeaders.length) throw new Error(`Missing Excel columns: ${missingHeaders.join(', ')}`);

  const shops = [] as Parameters<HandlerContext['syncBrandShops']>[0];
  const errors: string[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const shopId = cellText(row, columns.get('shopid')!);
    const appShopId = cellText(row, columns.get('appshopid')!);
    if (!shopId && !appShopId) continue;
    try {
      if (!isRawShopId(shopId)) throw new Error('shop_id must contain 19 digits and begin with 57');
      if (!appShopId) throw new Error('app_shop_id is required');
      const pickingModel = parsePickingModel(cellText(row, columns.get('pickingmodel')!));
      const cashColumn = columns.get('drivercashblocked');
      const driverCashBlocked = parseCashBlock(cashColumn ? cellText(row, cashColumn) : '');
      const schedules = SHOP_DAY_COLUMNS.flatMap(({ header, day }) => {
        const value = cellText(row, columns.get(header)!);
        if (isClosed(value)) return [];
        return parseScheduleString(value).map(range => ({ day, openTime: clock(range.begin), closeTime: clock(range.end) }));
      });
      if (!schedules.length) throw new Error('at least one day must be open');
      shops.push({ shopId, appShopId, pickingModel, driverCashBlocked, schedules });
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${(error as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`Shop integration Excel has ${errors.length} invalid row(s): ${errors.slice(0, 20).join('; ')}`);
  if (!shops.length) throw new Error('Shop integration Excel has no data rows');

  const sync = await ctx.syncBrandShops(shops);
  shops.forEach(value => ctx.addNote(`✓ ${value.shopId}: ${value.appShopId}, ${value.pickingModel}, cash blocked=${value.driverCashBlocked !== false}`));
  logger.log(`Added/synced ${sync.total} shops to local integration for ${ctx.brand.brandName}`);
  return { requested: shops.length, cashBlockDefault: true, ...sync };
}

registerHandler('update_shop_head_image', updateShopHeadImage);
registerHandler('replicate_store_menu', replicateStoreMenu);
registerHandler('check_shop_integration', checkShopIntegration);
registerHandler('add_shops_to_integration', addShopsToIntegration);
