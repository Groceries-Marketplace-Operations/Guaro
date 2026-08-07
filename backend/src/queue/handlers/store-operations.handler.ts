import { Logger } from '@nestjs/common';
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
  parseJsonKeepingIds,
  sleep,
} from './didi-food.util';

const logger = new Logger('store_operations');

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
  if (!imageKey || !/^[a-f0-9-]+\.(?:jpe?g|png|gif)$/i.test(imageKey)) {
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
  const map = await fetchShopIdMap(application.appId, application.appSecret, requested.filter(isRawShopId));
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
  const { brand, application } = requireBrand(ctx);
  const { requested, resolved, missing: unresolved } = await resolveTargets(ctx);
  const confirmed: typeof resolved = [];
  const missing = [...unresolved];
  for (const value of resolved) {
    if (isRawShopId(value.shopId)) {
      confirmed.push(value);
      continue;
    }
    try {
      await getAuthToken(application.appId, application.appSecret, value.appShopId);
      confirmed.push(value);
    } catch (error) {
      missing.push(value.shopId);
      ctx.addNote(`✗ ${value.shopId}: ${(error as Error).message}`);
    }
  }
  if (!confirmed.length) throw new Error('None of the requested shops belongs to the selected brand application');
  const sync = await ctx.syncBrandShops(confirmed.map(value => ({ shopId: value.shopId, appShopId: value.appShopId })));
  confirmed.forEach(value => ctx.addNote(`✓ ${value.shopId}: linked locally as ${value.appShopId}`));
  unresolved.forEach(shopId => ctx.addNote(`✗ ${shopId}: not returned by POST /v1/shop/shop/list`));
  logger.log(`Added/synced ${sync.total} shops to local integration for ${brand.brandName}`);
  return { requested: requested.length, confirmed: confirmed.length, missingShopIds: missing, ...sync };
}

registerHandler('update_shop_head_image', updateShopHeadImage);
registerHandler('replicate_store_menu', replicateStoreMenu);
registerHandler('check_shop_integration', checkShopIntegration);
registerHandler('add_shops_to_integration', addShopsToIntegration);
