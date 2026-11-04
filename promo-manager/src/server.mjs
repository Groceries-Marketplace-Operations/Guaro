import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { loadPromotions } from './converter.mjs';
import { analyzePromotionDataset, DIAGNOSTIC_RULES } from './diagnostics.mjs';
import { buildPlan, normalizeConfig, replacePlannedActivityIds, replacePlannedItemIds } from './planner.mjs';
import { parseJsonPreservingLargeIntegers, uploadJobs } from './uploader.mjs';
import { createSorianaSftp } from './soriana-sftp.mjs';
import { automationTypeSummary, normalizeAutomationDates, prepareDatasetForAutomation, rewritePromotionDates } from './sftp-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const allowedExtensions = new Set(['.csv', '.txt', '.tsv', '.xlsx', '.xls']);
const sessions = new Map();
const previews = new Map();
const sftpAutomationPreviews = new Map();
const taskQueryJobs = new Map();
const MAX_BODY = 18 * 1024 * 1024;
const MAX_SESSIONS = 5;
const MAX_PREVIEWS = 20;
const MAX_AUTOMATION_PREVIEWS = 5;
const MAX_AUTH_TOKEN_BATCH = 100;
const MAX_TASK_QUERY_JOBS = 2;
const TASK_QUERY_JOB_TTL_MS = 30 * 60_000;

try { process.loadEnvFile(path.join(root, '.env')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const configPath = process.env.PROMO_STORES_CONFIG_PATH
  ? path.resolve(process.env.PROMO_STORES_CONFIG_PATH)
  : path.join(root, 'stores.json');
const config = normalizeConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
const defaultSorianaSftp = createSorianaSftp();

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(value));
}

function download(response, fileName, buffer) {
  const fallbackName = String(fileName).replace(/[^\x20-\x7E]|["\\/]/g, '_');
  const encodedName = encodeURIComponent(String(fileName)).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': buffer.length,
    'content-disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(buffer);
}

function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/((?:auth_token|token|password|secret)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
    .slice(0, 1200);
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) throw new Error('La solicitud supera el límite local de 18 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('La solicitud supera el límite local de 18 MB.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('El body debe ser JSON válido.'); }
}

function prune(map, maximum) {
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function catalog(dataset) {
  return dataset.promotions.map(p => ({
    sourceShopId: p.sourceShopId,
    activityId: p.payload.activity_id,
    type: p.payload.activity_type,
    name: p.payload.activity_name,
    startDate: p.payload.start_date,
    endDate: p.payload.end_date,
    items: p.payload.item_activity_list.length,
    itemIds: p.payload.item_activity_list.map(item => String(item.app_item_id)),
  }));
}

function requireSession(id) {
  const session = typeof id === 'string' ? sessions.get(id) : null;
  if (!session) throw new Error('El archivo ya no está disponible. Vuelve a cargarlo.');
  return session;
}

function requireStore(id, availableStores = config.stores) {
  const store = availableStores.find(item => item.id === id);
  if (!store) throw new Error('Selecciona una tienda configurada.');
  return store;
}

function storesForAccount(availableStores, accountId) {
  const id = String(accountId ?? '').trim();
  return id ? availableStores.filter(store => store.sftpAccountId === id) : availableStores;
}

function requireStores(ids, destinationMode, availableStores = config.stores, accountId = '') {
  const scopedStores = storesForAccount(availableStores, accountId);
  if (accountId && !scopedStores.length) throw new Error('La marca seleccionada no tiene tiendas configuradas.');
  if (destinationMode === 'all') return [...scopedStores];
  const requested = Array.isArray(ids)
    ? [...new Set(ids.map(String).map(value => value.trim()).filter(Boolean))]
    : [];
  if (!requested.length) throw new Error('Selecciona al menos una tienda destino o elige toda la marca.');
  const stores = requested.map(id => requireStore(id, scopedStores));
  if (stores.length > scopedStores.length) throw new Error('La selección de tiendas no es válida.');
  return stores;
}

function ruleProfiles(accounts) {
  const profiles = [];
  const seen = new Set();
  for (const account of accounts) {
    const name = String(account?.name ?? '').trim();
    if (!name) continue;
    const soriana = /soriana/i.test(name);
    const id = soriana ? 'soriana' : `sftp:${String(account.id ?? name).trim()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id, name, activityAction: 1,
      appItemIdType: soriana ? 1 : config.defaults.appItemIdType,
      description: soriana
        ? 'Soriana identifica los productos por UPC.'
        : `Cuenta SFTP de promociones${account.filePattern ? ` · ${account.filePattern}` : ''}.`,
    });
  }
  if (!seen.has('soriana')) profiles.unshift({
    id: 'soriana', name: 'Soriana', activityAction: 1, appItemIdType: 1,
    description: 'Soriana identifica los productos por UPC.',
  });
  return profiles.sort((a, b) => a.id === 'soriana' ? -1 : b.id === 'soriana' ? 1 : a.name.localeCompare(b.name, 'es'));
}

function accountHash(accountId) {
  return createHash('sha256').update(String(accountId)).digest('hex').slice(0, 12);
}

function buildRuntimeStores(accounts, legacyRemoteStores = []) {
  const baseByAppShopId = new Map(config.stores.map(store => [store.appShopId, store]));
  const baseByShopId = new Map(config.stores.filter(store => store.shopId).map(store => [store.shopId, store]));
  const stores = [];
  const seenIds = new Set();
  for (const account of accounts) {
    const accountId = String(account?.id ?? '').trim();
    if (!accountId) continue;
    const isSoriana = /soriana/i.test(`${account.name ?? ''} ${account.brandName ?? ''}`);
    let remoteStores = Array.isArray(account.stores) ? account.stores : [];
    if (!remoteStores.length && isSoriana && legacyRemoteStores.length) remoteStores = legacyRemoteStores;
    if (!remoteStores.length && isSoriana) remoteStores = config.stores;
    const hash = accountHash(accountId);
    for (const remote of remoteStores) {
      const appShopId = String(remote?.appShopId ?? '').trim();
      if (!/^[A-Za-z0-9]{1,64}$/.test(appShopId)) continue;
      const shopId = String(remote?.shopId ?? '').trim();
      const base = isSoriana ? (baseByShopId.get(shopId) ?? baseByAppShopId.get(appShopId)) : null;
      let id = base?.id ?? `brand_${hash}_${appShopId}`;
      if (seenIds.has(id)) id = `brand_${hash}_${appShopId}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      stores.push({
        ...(base ?? {}),
        id,
        name: String(remote?.name ?? '').trim() || base?.name || `Tienda ${appShopId}`,
        city: String(remote?.city ?? '').trim() || base?.city || '',
        shopId: shopId || base?.shopId || '',
        appShopId,
        authTokenEnv: base?.authTokenEnv ?? `DIDI_DYNAMIC_${hash.toUpperCase()}_${appShopId}`,
        appItemIdType: base?.appItemIdType ?? (isSoriana ? 1 : config.defaults.appItemIdType),
        sourceShopIds: base?.sourceShopIds ?? ['*'],
        includeActivityIds: base?.includeActivityIds ?? [],
        excludeActivityIds: base?.excludeActivityIds ?? [],
        sftpAccountId: accountId,
        brandId: String(account?.brandId ?? '').trim(),
        brandName: String(account?.brandName ?? '').trim() || String(account?.name ?? accountId),
      });
    }
  }
  if (!stores.length) {
    const fallback = accounts.find(account => /soriana/i.test(account?.name ?? '')) ?? accounts[0];
    const accountId = String(fallback?.id ?? 'soriana');
    return config.stores.map(store => ({
      ...store,
      sftpAccountId: accountId,
      brandId: String(fallback?.brandId ?? ''),
      brandName: String(fallback?.brandName ?? fallback?.name ?? 'Soriana'),
    }));
  }
  return stores;
}

function resolveDuplicateItems(dataset, selections, selectedActivityIds, selectedTypes, defaultAction, activityActionsInput) {
  const conflicts = Array.isArray(dataset.duplicateItemConflicts) ? dataset.duplicateItemConflicts : [];
  if (!conflicts.length) return { dataset, resolutions: [] };
  const selectedIds = new Set(selectedActivityIds.map(String));
  const types = new Set(selectedTypes.map(Number));
  const actionOverrides = new Map((Array.isArray(activityActionsInput) ? activityActionsInput : []).map(entry => [String(entry?.activityId ?? ''), Number(entry?.action)]));
  const required = conflicts.filter(conflict =>
    selectedIds.has(String(conflict.activityId))
    && types.has(Number(conflict.activityType))
    && (actionOverrides.get(String(conflict.activityId)) ?? defaultAction) === 1
  );
  const conflictById = new Map(conflicts.map(conflict => [String(conflict.id), conflict]));
  const chosenById = new Map();
  for (const entry of Array.isArray(selections) ? selections : []) {
    const conflictId = String(entry?.conflictId ?? '').trim();
    const row = Number(entry?.row);
    if (!conflictById.has(conflictId)) throw new Error(`La selección de UPC repetido ${conflictId || '(vacía)'} no pertenece al archivo.`);
    if (chosenById.has(conflictId)) throw new Error(`El UPC repetido ${conflictId} tiene más de una selección.`);
    const candidate = conflictById.get(conflictId).candidates.find(item => item.row === row);
    if (!candidate) throw new Error(`La fila elegida para ${conflictId} no pertenece a sus opciones.`);
    chosenById.set(conflictId, candidate);
  }
  for (const conflict of required) {
    if (!chosenById.has(String(conflict.id))) {
      throw new Error(`Elige qué fila conservar para el UPC ${conflict.sku} de la actividad ${conflict.activityId}.`);
    }
  }
  if (!required.length) return { dataset, resolutions: [] };
  const resolved = structuredClone(dataset);
  const resolutions = [];
  for (const conflict of required) {
    const selected = chosenById.get(String(conflict.id));
    const promotion = resolved.promotions.find(item => item.sourceShopId === conflict.sourceShopId && String(item.payload.activity_id) === String(conflict.activityId));
    const itemIndex = promotion?.payload?.item_activity_list?.findIndex(item => String(item.app_item_id) === String(conflict.sku)) ?? -1;
    if (!promotion || itemIndex < 0) throw new Error(`No se pudo aplicar la elección del UPC ${conflict.sku}. Vuelve a cargar el archivo.`);
    promotion.payload.item_activity_list[itemIndex] = structuredClone(selected.item);
    resolutions.push({
      conflictId: String(conflict.id),
      sourceShopId: String(conflict.sourceShopId),
      activityId: String(conflict.activityId),
      sku: String(conflict.sku),
      selectedRow: selected.row,
      discardedRows: conflict.candidates.filter(candidate => candidate.row !== selected.row).map(candidate => candidate.row),
    });
  }
  return { dataset: resolved, resolutions };
}

function resolveZeroDiscounts(dataset, policyInput, selectedActivityIds, selectedTypes, defaultAction, activityActionsInput) {
  const policy = String(policyInput ?? '').trim();
  if (policy && !['omit', 'keep'].includes(policy)) throw new Error('La decisión para descuentos de 0% debe ser omitir o conservar.');
  const selectedIds = new Set(selectedActivityIds.map(String));
  const types = new Set(selectedTypes.map(Number));
  const actionOverrides = new Map((Array.isArray(activityActionsInput) ? activityActionsInput : []).map(entry => [String(entry?.activityId ?? ''), Number(entry?.action)]));
  const relevantPromotions = dataset.promotions.filter(promotion =>
    selectedIds.has(String(promotion.payload.activity_id))
    && types.has(Number(promotion.payload.activity_type))
    && (actionOverrides.get(String(promotion.payload.activity_id)) ?? defaultAction) === 1
  );
  const affected = relevantPromotions.flatMap(promotion => promotion.payload.item_activity_list
    .filter(item => item.discount_perc === 0)
    .map(item => ({ sourceShopId: promotion.sourceShopId, activityId: String(promotion.payload.activity_id), sku: String(item.app_item_id) })));
  if (!affected.length) return { dataset, resolution: { policy: null, affectedItems: 0, omittedItems: 0, rows: [] } };
  if (!policy) throw new Error(`Elige si se ${affected.length === 1 ? 'omite o se conserva 1 producto' : `omiten o se conservan ${affected.length} productos`} con descuento de 0%.`);
  const affectedKeys = new Set(affected.map(item => JSON.stringify([item.sourceShopId, item.activityId, item.sku])));
  const rows = (Array.isArray(dataset.zeroDiscountItems) ? dataset.zeroDiscountItems : [])
    .filter(item => affectedKeys.has(JSON.stringify([item.sourceShopId, String(item.activityId), String(item.sku)])))
    .map(item => item.row);
  if (policy === 'keep') return { dataset, resolution: { policy, affectedItems: affected.length, omittedItems: 0, rows } };
  const resolved = structuredClone(dataset);
  for (const promotion of resolved.promotions) {
    if (!relevantPromotions.some(item => item.sourceShopId === promotion.sourceShopId && String(item.payload.activity_id) === String(promotion.payload.activity_id))) continue;
    promotion.payload.item_activity_list = promotion.payload.item_activity_list.filter(item => item.discount_perc !== 0);
    if (!promotion.payload.item_activity_list.length) {
      throw new Error(`Omitir descuentos de 0% dejaría la actividad ${promotion.payload.activity_id} sin productos. Conserva esas filas o no selecciones la actividad.`);
    }
  }
  return { dataset: resolved, resolution: { policy, affectedItems: affected.length, omittedItems: affected.length, rows } };
}

function resolveUnsupportedPercentages(dataset, policyInput, selectedActivityIds, selectedTypes, defaultAction, activityActionsInput) {
  const policy = String(policyInput ?? '').trim();
  if (policy && policy !== 'omit') throw new Error('La decisión para porcentajes no admitidos debe ser omitirlos.');
  const selectedIds = new Set(selectedActivityIds.map(String));
  const types = new Set(selectedTypes.map(Number));
  const actionOverrides = new Map((Array.isArray(activityActionsInput) ? activityActionsInput : []).map(entry => [String(entry?.activityId ?? ''), Number(entry?.action)]));
  const relevantPromotions = dataset.promotions.filter(promotion =>
    selectedIds.has(String(promotion.payload.activity_id))
    && types.has(Number(promotion.payload.activity_type))
    && (actionOverrides.get(String(promotion.payload.activity_id)) ?? defaultAction) === 1
  );
  const unsupported = value => Number.isInteger(value) && value !== 0 && (value < 5 || value > 99);
  const affected = relevantPromotions.flatMap(promotion => promotion.payload.item_activity_list
    .filter(item => unsupported(item.discount_perc))
    .map(item => ({
      sourceShopId: promotion.sourceShopId,
      activityId: String(promotion.payload.activity_id),
      sku: String(item.app_item_id),
      discountPercentage: item.discount_perc,
    })));
  if (!affected.length) return { dataset, resolution: { policy: null, affectedItems: 0, omittedItems: 0, rows: [], values: {} } };
  if (!policy) {
    throw new Error(`DiDi solo admite discount_perc enteros de 5 a 99. Elige omitir ${affected.length === 1 ? 'el producto fuera de rango' : `los ${affected.length} productos fuera de rango`} para continuar.`);
  }
  const affectedKeys = new Set(affected.map(item => JSON.stringify([item.sourceShopId, item.activityId, item.sku, item.discountPercentage])));
  const rows = (Array.isArray(dataset.unsupportedPercentageItems) ? dataset.unsupportedPercentageItems : [])
    .filter(item => affectedKeys.has(JSON.stringify([item.sourceShopId, String(item.activityId), String(item.sku), item.discountPercentage])))
    .map(item => item.row);
  const values = Object.fromEntries([...affected.reduce((counts, item) => {
    const key = String(item.discountPercentage);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => Number(left) - Number(right)));
  const resolved = structuredClone(dataset);
  for (const promotion of resolved.promotions) {
    if (!relevantPromotions.some(item => item.sourceShopId === promotion.sourceShopId && String(item.payload.activity_id) === String(promotion.payload.activity_id))) continue;
    promotion.payload.item_activity_list = promotion.payload.item_activity_list.filter(item => !unsupported(item.discount_perc));
    if (!promotion.payload.item_activity_list.length) {
      throw new Error(`Omitir los porcentajes fuera del rango de 5 a 99 dejaría la actividad ${promotion.payload.activity_id} sin productos. No selecciones esa actividad o corrige el archivo.`);
    }
  }
  return { dataset: resolved, resolution: { policy, affectedItems: affected.length, omittedItems: affected.length, rows, values } };
}

function makePlan(session, body, runtimeConfig = config) {
  if (runtimeConfig.stores.some(store => store.sftpAccountId) && !String(body.sftpAccountId ?? '').trim()) {
    throw new Error('Selecciona la marca / cuenta SFTP antes de elegir las tiendas destino.');
  }
  const stores = requireStores(
    body.storeIds ?? (body.storeId ? [body.storeId] : []),
    body.destinationMode,
    runtimeConfig.stores,
    body.sftpAccountId,
  );
  const activityIds = Array.isArray(body.activityIds)
    ? [...new Set(body.activityIds.map(String).map(value => value.trim()).filter(Boolean))]
    : [];
  if (!activityIds.length) throw new Error('Selecciona al menos una promoción.');
  const types = Array.isArray(body.types) ? body.types.map(Number) : [2, 4, 8];
  const activityAction = Number(body.activityAction ?? 1);
  if (![1, 2].includes(activityAction)) throw new Error('Activity action debe ser 1 (crear) o 2 (detener).');
  const appItemIdType = Number(body.appItemIdType ?? runtimeConfig.defaults.appItemIdType);
  if (![0, 1].includes(appItemIdType)) throw new Error('app_item_id_type debe ser 0 (app_item_id) o 1 (UPC).');
  const mode = body.idMode ?? 'keep';
  if (!['keep', 'manual', 'random'].includes(mode)) throw new Error('Modo de ActivityID inválido.');
  const duplicateResolution = resolveDuplicateItems(
    session.dataset,
    body.duplicateItemSelections,
    activityIds,
    types,
    activityAction,
    body.activityActions,
  );
  const zeroDiscountResolution = resolveZeroDiscounts(
    duplicateResolution.dataset,
    body.zeroDiscountPolicy,
    activityIds,
    types,
    activityAction,
    body.activityActions,
  );
  const unsupportedPercentageResolution = resolveUnsupportedPercentages(
    zeroDiscountResolution.dataset,
    body.unsupportedPercentagePolicy,
    activityIds,
    types,
    activityAction,
    body.activityActions,
  );
  const plan = buildPlan(unsupportedPercentageResolution.dataset, runtimeConfig, {
    ids: activityIds,
    types,
    storeIds: stores.map(store => store.id),
    activityAction,
    activityActions: body.activityActions,
    appItemIdType,
    groupSameTypeAndValidity: body.groupSameTypeAndValidity === true,
  });
  plan.selection.duplicateItemResolution = { mappings: duplicateResolution.resolutions };
  plan.selection.zeroDiscountResolution = zeroDiscountResolution.resolution;
  plan.selection.unsupportedPercentageResolution = unsupportedPercentageResolution.resolution;
  const hasCreateActions = plan.totals.actions.create > 0;
  if (!hasCreateActions && mode !== 'keep') throw new Error('No hay promociones con action 1 para cambiar el Activity ID.');
  if (!hasCreateActions && Array.isArray(body.itemIdReplacements) && body.itemIdReplacements.length) {
    throw new Error('No hay promociones con action 1 para cambiar UPC.');
  }
  if (hasCreateActions) {
    replacePlannedActivityIds(plan, {
      manualId: mode === 'manual' ? String(body.newActivityId ?? '') : undefined,
      random: mode === 'random',
      reservedIds: session.dataset.promotions.map(p => p.payload.activity_id),
    });
    replacePlannedItemIds(plan, body.itemIdReplacements);
  }
  return { plan, stores };
}

function resolveToken(store, supplied) {
  const token = (typeof supplied === 'string' ? supplied : process.env[store.authTokenEnv] ?? '').trim();
  if (!token || /\s/.test(token)) throw new Error(`Falta un auth_token válido para ${store.name}.`);
  return token;
}

async function resolveTokens(stores, supplied, provider, onProgress = null) {
  if (stores.length === 1) {
    const store = stores[0];
    const provided = typeof supplied === 'string' ? supplied.trim() : '';
    const configured = (process.env[store.authTokenEnv] ?? '').trim();
    if (provided || configured) {
      onProgress?.({ batchesDone: 1, batchesTotal: 1, storesDone: 1, storesTotal: 1 });
      return new Map([[store.id, resolveToken(store, supplied)]]);
    }
  } else if (typeof supplied === 'string' && supplied.trim()) {
    throw new Error('Un solo auth_token no puede reutilizarse para varias tiendas. La autenticación múltiple se genera en Tequila.');
  }
  if (!provider?.authConfigured || typeof provider.getAuthTokens !== 'function') {
    throw new Error('No está configurada la autenticación segura para las tiendas seleccionadas.');
  }
  const tokens = new Map();
  const batchesTotal = Math.ceil(stores.length / MAX_AUTH_TOKEN_BATCH);
  for (let index = 0; index < stores.length; index += MAX_AUTH_TOKEN_BATCH) {
    const batch = stores.slice(index, index + MAX_AUTH_TOKEN_BATCH);
    const resolved = await provider.getAuthTokens(batch);
    for (const [storeId, token] of resolved) tokens.set(storeId, token);
    onProgress?.({
      batchesDone: Math.floor(index / MAX_AUTH_TOKEN_BATCH) + 1,
      batchesTotal,
      storesDone: Math.min(index + batch.length, stores.length),
      storesTotal: stores.length,
    });
  }
  return tokens;
}

function promotionTaskEndpoint(apiUrl) {
  if (!apiUrl) throw new Error(`Falta ${config.api.urlEnv} en .env.`);
  return new URL('/v1/promo/promo/getGroceryPromoTaskInfo', apiUrl).href;
}

async function queryPromotionTask({ store, token, taskId, batchNumber, apiUrl, fetchImpl = fetch }) {
  const endpoint = promotionTaskEndpoint(apiUrl);
  const rawBody = `{"auth_token":${JSON.stringify(token)},"task_id":${taskId}}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const remote = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: rawBody, signal: controller.signal, redirect: 'error',
    });
    const raw = await remote.text();
    let data;
    try { data = parseJsonPreservingLargeIntegers(raw); }
    catch { data = { rawBody: raw.slice(0, 16_384), truncated: raw.length > 16_384 }; }
    const errno = data && typeof data === 'object' ? data.errno : undefined;
    return {
      storeId: store.id, storeName: store.name, batchNumber, taskId,
      httpStatus: remote.status,
      queryStatus: !remote.ok ? 'http_error' : Object.is(errno, 0) ? 'queried' : 'api_error',
      response: data,
    };
  } finally { clearTimeout(timer); }
}

function prepareTaskQueries(entries, stores) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 2000) {
    throw new Error('tasks debe contener entre 1 y 2000 consultas.');
  }
  const tasks = [];
  const unique = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Task ${index + 1} no es válido.`);
    const store = requireStore(entry.storeId, stores);
    const taskId = String(entry.taskId ?? '').trim();
    if (!/^\d{1,64}$/.test(taskId)) throw new Error(`Task ID ${index + 1} debe contener únicamente dígitos.`);
    const key = `${store.id}:${taskId}`;
    if (unique.has(key)) throw new Error(`La consulta ${store.name} / ${taskId} está repetida.`);
    unique.add(key);
    const batchNumber = Number(entry.batchNumber);
    tasks.push({ store, taskId, batchNumber: Number.isSafeInteger(batchNumber) && batchNumber > 0 ? batchNumber : null });
  }
  return tasks;
}

function taskQueryResultSummary(result, jobIndex) {
  const details = Array.isArray(result?.response?.data?.details) ? result.response.data.details : [];
  const codes = {};
  let code200 = 0;
  for (const detail of details) {
    const code = String(detail?.errno ?? 'sin código');
    codes[code] = (codes[code] ?? 0) + 1;
    if (Number(detail?.errno) === 200) code200 += 1;
  }
  return {
    jobIndex,
    storeId: result.storeId,
    storeName: result.storeName,
    batchNumber: result.batchNumber,
    taskId: result.taskId,
    httpStatus: result.httpStatus,
    queryStatus: result.queryStatus,
    ...(result.error ? { error: result.error } : {}),
    detailSummary: {
      total: details.length,
      code200,
      incidents: details.length - code200,
      codes,
    },
  };
}

async function executeTaskQueries({ tasks, tokens, apiUrl, fetchImpl, onResult = null }) {
  const results = new Array(tasks.length);
  let cursor = 0;
  let completed = 0;
  let queried = 0;
  let errors = 0;
  const workers = Array.from({ length: Math.min(8, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      const task = tasks[index];
      let result;
      try {
        result = await queryPromotionTask({
          ...task, token: tokens.get(task.store.id), apiUrl, fetchImpl,
        });
      } catch (error) {
        result = {
          storeId: task.store.id, storeName: task.store.name, batchNumber: task.batchNumber,
          taskId: task.taskId, queryStatus: 'network_error', error: safeMessage(error),
        };
      }
      results[index] = result;
      completed += 1;
      if (result.queryStatus === 'queried') queried += 1;
      else errors += 1;
      onResult?.({ index, result, completed, queried, errors });
    }
  });
  await Promise.all(workers);
  return { total: results.length, queried, errors, results };
}

function pruneTaskQueryJobs(now = Date.now()) {
  for (const [id, job] of taskQueryJobs) {
    if (now - job.createdAtMs > TASK_QUERY_JOB_TTL_MS) taskQueryJobs.delete(id);
  }
  while (taskQueryJobs.size > MAX_TASK_QUERY_JOBS) taskQueryJobs.delete(taskQueryJobs.keys().next().value);
}

function publicTaskQueryJob(job, after = 0) {
  const cursor = Number.isSafeInteger(after) && after >= 0 ? Math.min(after, job.updates.length) : 0;
  const now = Date.now();
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    total: job.total,
    completed: job.completed,
    queried: job.queried,
    errors: job.errors,
    pending: Math.max(0, job.total - job.completed),
    authBatchesDone: job.authBatchesDone,
    authBatchesTotal: job.authBatchesTotal,
    authStoresDone: job.authStoresDone,
    authStoresTotal: job.authStoresTotal,
    concurrency: job.concurrency,
    elapsedMs: Math.max(0, (job.finishedAtMs ?? now) - job.createdAtMs),
    queryElapsedMs: job.queryStartedAtMs ? Math.max(0, (job.finishedAtMs ?? now) - job.queryStartedAtMs) : 0,
    nextCursor: job.updates.length,
    updates: job.updates.slice(cursor),
    ...(job.error ? { error: job.error } : {}),
  };
}

async function runTaskQueryJob({ job, tasks, suppliedToken, provider, apiUrl, fetchImpl }) {
  try {
    const stores = [...new Map(tasks.map(task => [task.store.id, task.store])).values()];
    job.authStoresTotal = stores.length;
    job.authBatchesTotal = Math.ceil(stores.length / MAX_AUTH_TOKEN_BATCH);
    const tokens = await resolveTokens(stores, suppliedToken, provider, progress => {
      job.authBatchesDone = progress.batchesDone;
      job.authBatchesTotal = progress.batchesTotal;
      job.authStoresDone = progress.storesDone;
      job.authStoresTotal = progress.storesTotal;
      job.updatedAtMs = Date.now();
    });
    job.phase = 'querying';
    job.queryStartedAtMs = Date.now();
    job.updatedAtMs = job.queryStartedAtMs;
    const outcome = await executeTaskQueries({
      tasks, tokens, apiUrl, fetchImpl,
      onResult: ({ index, result, completed, queried, errors }) => {
        job.results[index] = result;
        job.updates.push(taskQueryResultSummary(result, index));
        job.completed = completed;
        job.queried = queried;
        job.errors = errors;
        job.updatedAtMs = Date.now();
      },
    });
    job.completed = outcome.total;
    job.queried = outcome.queried;
    job.errors = outcome.errors;
    job.phase = 'complete';
    job.status = 'complete';
    job.finishedAtMs = Date.now();
    job.updatedAtMs = job.finishedAtMs;
  } catch (error) {
    job.phase = 'failed';
    job.status = 'failed';
    job.error = safeMessage(error);
    job.finishedAtMs = Date.now();
    job.updatedAtMs = job.finishedAtMs;
  }
}

function auditStore(store) {
  return {
    id: store.id,
    name: store.name,
    city: store.city ?? '',
    shopId: store.shopId ?? '',
    appShopId: store.appShopId ?? '',
    brandId: store.brandId ?? '',
    brandName: store.brandName ?? '',
    sftpAccountId: store.sftpAccountId ?? '',
    sourceShopIds: store.sourceShopIds ?? [],
    appItemIdType: store.appItemIdType,
  };
}

function safeDirectorySegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'tienda';
}

async function writePrivateJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function appendAuditEvent(directory, event) {
  const handle = await fs.open(path.join(directory, 'eventos.jsonl'), 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ recordedAt: new Date().toISOString(), ...event })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stopInventory(preview) {
  const stores = new Map();
  for (const job of preview.plan.jobs) {
    let entry = stores.get(job.store.id);
    if (!entry) {
      entry = { store: auditStore(job.store), promotions: new Map() };
      stores.set(job.store.id, entry);
    }
    for (const promotion of job.payload.promo_list) {
      if (promotion.action !== 1) continue;
      const activityId = String(promotion.activity_id);
      const existing = entry.promotions.get(activityId);
      if (existing) {
        if (!existing.batchNumbers.includes(job.batchNumber)) existing.batchNumbers.push(job.batchNumber);
        continue;
      }
      entry.promotions.set(activityId, {
        activityId,
        activityName: promotion.activity_name,
        activityType: promotion.activity_type,
        startDate: promotion.start_date,
        endDate: promotion.end_date,
        batchNumbers: [job.batchNumber],
      });
    }
  }
  return {
    version: 1,
    createdAt: preview.createdAt,
    previewId: preview.id,
    warning: 'Inventario de referencia. No detiene promociones automáticamente; revisa los Task ID y confirma el destino antes de usar action 2.',
    stores: [...stores.values()].map(entry => {
      const promotions = [...entry.promotions.values()];
      const stopRequests = [];
      for (let index = 0; index < promotions.length; index += 499) {
        stopRequests.push({
          auth_token: '{{auth_token}}',
          app_item_id_type: entry.store.appItemIdType,
          promo_list: promotions.slice(index, index + 499).map(promotion => ({ action: 2, activity_id: promotion.activityId })),
        });
      }
      return { ...entry.store, promotions, stopRequests };
    }),
  };
}

async function createPreviewAudit(preview, session, auditRoot, accountId) {
  await fs.mkdir(auditRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = await fs.mkdtemp(path.join(auditRoot, `web-${stamp}-`));
  const jobs = [];
  for (const job of preview.plan.jobs) {
    const relativeFile = `solicitudes/tienda_${safeDirectorySegment(job.store.id)}/lote_${String(job.batchNumber).padStart(3, '0')}.json`;
    const absoluteFile = path.join(directory, ...relativeFile.split('/'));
    await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
    await writePrivateJson(absoluteFile, job.payload);
    jobs.push({
      store: auditStore(job.store),
      sourceShopIds: job.sourceShopIds,
      batchNumber: job.batchNumber,
      promotions: job.payload.promo_list.map(promotion => ({
        action: promotion.action,
        activityId: String(promotion.activity_id),
        activityName: promotion.activity_name ?? null,
        activityType: promotion.activity_type ?? null,
        items: promotion.item_activity_list?.length ?? 0,
      })),
      file: relativeFile,
    });
  }
  const request = {
    previewId: preview.id,
    createdAt: preview.createdAt,
    stores: preview.stores.map(auditStore),
    selection: preview.plan.selection,
    jobs: preview.plan.jobs.map(job => ({
      store: auditStore(job.store),
      sourceShopIds: job.sourceShopIds,
      batchNumber: job.batchNumber,
      payload: job.payload,
    })),
  };
  const manifest = {
    version: 1,
    previewId: preview.id,
    createdAt: preview.createdAt,
    updatedAt: preview.createdAt,
    status: 'preview_generated',
    source: {
      ...session.dataset.meta,
      fileName: session.fileName,
      sha256: session.sha256,
      loadedAt: session.createdAt,
      sftpAccountId: String(accountId ?? ''),
    },
    sourceStats: session.dataset.stats,
    selection: preview.plan.selection,
    totals: preview.plan.totals,
    warnings: [...session.dataset.warnings, ...preview.plan.warnings],
    stores: preview.stores.map(auditStore),
    jobs,
    files: {
      requests: 'solicitudes/',
      exactRequestLog: 'request.json',
      stopInventory: 'promociones_para_detener.json',
      events: 'eventos.jsonl',
    },
  };
  await writePrivateJson(path.join(directory, 'request.json'), request);
  await writePrivateJson(path.join(directory, 'promociones_para_detener.json'), stopInventory(preview));
  await writePrivateJson(path.join(directory, 'manifest.json'), manifest);
  await appendAuditEvent(directory, {
    event: 'preview_generated',
    previewId: preview.id,
    requests: preview.plan.totals.requests,
    stores: preview.plan.totals.stores,
    promotions: preview.plan.totals.promotions,
    items: preview.plan.totals.items,
  });
  return { directory, manifest };
}

async function updateAuditManifest(preview, changes) {
  Object.assign(preview.audit.manifest, changes, { updatedAt: new Date().toISOString() });
  await writePrivateJson(path.join(preview.audit.directory, 'manifest.json'), preview.audit.manifest);
}

async function recordAuditError(preview, phase, error) {
  const detail = {
    recordedAt: new Date().toISOString(),
    phase,
    message: safeMessage(error),
    summary: error?.summary ?? null,
  };
  await writePrivateJson(path.join(preview.audit.directory, 'error.json'), detail);
  await appendAuditEvent(preview.audit.directory, { event: 'error', ...detail });
  await updateAuditManifest(preview, { status: 'error', lastError: detail });
}

async function loadDatasetFromBuffer(fileNameInput, buffer, options = {}) {
  const fileName = path.basename(String(fileNameInput ?? ''));
  const extension = path.extname(fileName).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error('Usa un archivo CSV, TXT, TSV, XLSX o XLS.');
  if (!Buffer.isBuffer(buffer)) throw new Error('El archivo está vacío.');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('El archivo debe pesar entre 1 byte y 12 MB.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'didi-promo-ui-'));
  const temporaryFile = path.join(temporary, `input${extension}`);
  try {
    await fs.writeFile(temporaryFile, buffer, { mode: 0o600 });
    const dataset = await loadPromotions(temporaryFile, {
      fileName,
      encoding: options.encoding ?? 'utf-8',
      moneyUnit: options.moneyUnit ?? config.defaults.moneyUnit,
    });
    return { fileName, dataset };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function parseUploadBuffer(fileNameInput, buffer, options = {}) {
  const { fileName, dataset } = await loadDatasetFromBuffer(fileNameInput, buffer, options);
  const id = randomUUID();
  sessions.set(id, {
    id, fileName, dataset, createdAt: new Date().toISOString(),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
  prune(sessions, MAX_SESSIONS);
  return {
    sessionId: id,
    fileName,
    sha256: sessions.get(id).sha256,
    stats: dataset.stats,
    warnings: dataset.warnings,
    duplicateItemConflicts: dataset.duplicateItemConflicts ?? [],
    zeroDiscountItems: dataset.zeroDiscountItems ?? [],
    unsupportedPercentageItems: dataset.unsupportedPercentageItems ?? [],
    promotions: catalog(dataset),
  };
}

async function parseUpload(body) {
  if (typeof body.contentBase64 !== 'string' || !body.contentBase64) throw new Error('El archivo está vacío.');
  return parseUploadBuffer(body.fileName, Buffer.from(body.contentBase64, 'base64'), body);
}

async function serveStatic(requestPath, response) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/extra.css': ['extra.css', 'text/css; charset=utf-8'],
  };
  const selected = files[requestPath];
  if (!selected) return false;
  const content = await fs.readFile(path.join(webRoot, selected[0]));
  response.writeHead(200, {
    'content-type': selected[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(content);
  return true;
}

function promotionBrandGroups(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const brandId = String(account?.brandId ?? '').trim();
    const brandName = String(account?.brandName ?? '').trim()
      || String(account?.name ?? account?.id ?? '').trim()
      || 'Marca sin nombre';
    const key = brandId ? `id:${brandId}` : `name:${brandName.toLocaleLowerCase('es')}`;
    if (!groups.has(key)) groups.set(key, { brandId, brandName, accounts: [] });
    groups.get(key).accounts.push(account);
  }
  return [...groups.values()].sort((a, b) => a.brandName.localeCompare(b.brandName, 'es'));
}

function diagnosticFileOrder(left, right) {
  const leftDate = String(left.file.modifiedAt ?? left.file.fileTimestamp ?? '');
  const rightDate = String(right.file.modifiedAt ?? right.file.fileTimestamp ?? '');
  return rightDate.localeCompare(leftDate) || String(right.file.name).localeCompare(String(left.file.name));
}

function diagnosticStoreForFile(account, file) {
  const sourceShopId = String(file.sourceShopId ?? '');
  return (account.stores ?? []).find(store =>
    String(store.appShopId ?? '') === sourceShopId || String(store.shopId ?? '') === sourceShopId
  );
}

function diagnosticSampleOptions(candidates) {
  const seen = new Set();
  const options = [];
  for (const { account, file } of candidates) {
    const sourceShopId = String(file.sourceShopId ?? '');
    const key = sourceShopId || `${account.id}\0${file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const store = diagnosticStoreForFile(account, file);
    options.push({
      accountId: String(account.id),
      fileName: String(file.name),
      sourceShopId,
      storeName: String(store?.name ?? ''),
      city: String(store?.city ?? ''),
      shopId: String(store?.shopId ?? ''),
      appShopId: String(store?.appShopId ?? ''),
      fileTimestamp: file.fileTimestamp ?? null,
      modifiedAt: file.modifiedAt ?? null,
      size: file.size ?? null,
    });
  }
  return options;
}

async function diagnosePromotionBrand(group, { sorianaSftp, force, now, selection = null }) {
  const candidates = [];
  const listingErrors = [];
  for (const account of group.accounts) {
    try {
      const files = await sorianaSftp.listFiles({ force, accountId: account.id });
      for (const file of files) if (file.loadable) candidates.push({ account, file });
    } catch (error) {
      listingErrors.push(`${account.name ?? account.id}: ${safeMessage(error)}`);
    }
  }
  if (!candidates.length) {
    const message = listingErrors.length
      ? 'No fue posible listar una muestra de la marca.'
      : 'No existe un archivo cargable para tomar una tienda de muestra.';
    return {
      brandId: group.brandId,
      brandName: group.brandName,
      accountIds: group.accounts.map(account => String(account.id)),
      status: 'unavailable',
      sample: null,
      sampleOptions: [],
      anomalies: [{
        code: listingErrors.length ? 'SFTP_LIST_UNAVAILABLE' : 'NO_LOADABLE_SAMPLE',
        severity: 'critical',
        title: listingErrors.length ? 'SFTP no disponible' : 'Sin archivo de muestra',
        message,
        count: 1,
        evidence: listingErrors.slice(0, 5),
      }],
    };
  }
  candidates.sort(diagnosticFileOrder);
  const sampleOptions = diagnosticSampleOptions(candidates);
  const selected = selection
    ? candidates.find(candidate => String(candidate.account.id) === String(selection.accountId)
      && String(candidate.file.name) === String(selection.fileName))
    : candidates[0];
  if (!selected) throw new Error('La tienda o el archivo elegido ya no está disponible para diagnóstico. Actualiza la sección.');
  const { account, file } = selected;
  let remote;
  try {
    remote = await sorianaSftp.download(file.name, { accountId: account.id });
  } catch (error) {
    return {
      brandId: group.brandId,
      brandName: group.brandName,
      accountIds: group.accounts.map(candidate => String(candidate.id)),
      status: 'unavailable',
      sample: { accountId: account.id, fileName: file.name, sourceShopId: file.sourceShopId ?? '', fileTimestamp: file.fileTimestamp ?? null, modifiedAt: file.modifiedAt ?? null, size: file.size ?? null },
      sampleOptions,
      anomalies: [{ code: 'SFTP_DOWNLOAD_UNAVAILABLE', severity: 'critical', title: 'No se pudo descargar la muestra', message: safeMessage(error), count: 1, evidence: [file.name] }],
    };
  }
  let loaded;
  let encoding = 'utf-8';
  try {
    loaded = await loadDatasetFromBuffer(remote.fileName, remote.buffer, { encoding });
  } catch (error) {
    if (/no usa utf-8/i.test(safeMessage(error))) {
      try {
        encoding = 'windows-1252';
        loaded = await loadDatasetFromBuffer(remote.fileName, remote.buffer, { encoding });
      } catch (fallbackError) {
        error = fallbackError;
      }
    }
    if (!loaded) {
      return {
        brandId: group.brandId,
        brandName: group.brandName,
        accountIds: group.accounts.map(candidate => String(candidate.id)),
        status: 'critical',
        sample: { accountId: account.id, fileName: file.name, sourceShopId: file.sourceShopId ?? '', fileTimestamp: file.fileTimestamp ?? null, modifiedAt: file.modifiedAt ?? null, size: file.size ?? remote.buffer.length },
        sampleOptions,
        anomalies: [{ code: 'INVALID_STANDARD_FILE', severity: 'critical', title: 'Archivo fuera del estándar', message: safeMessage(error), count: 1, evidence: [file.name] }],
      };
    }
  }
  const dataset = loaded.dataset;
  const sourceShopId = String(file.sourceShopId ?? dataset.stats.sourceShops?.[0] ?? '');
  const sampledStore = diagnosticStoreForFile(account, { ...file, sourceShopId });
  const diagnosis = analyzePromotionDataset(dataset, { file, account, encoding, now });
  if (listingErrors.length) diagnosis.anomalies.push({
    code: 'SECONDARY_ACCOUNT_UNAVAILABLE', severity: 'info', title: 'Otra cuenta de la misma marca no respondió',
    message: 'La muestra sí se analizó, pero una cuenta adicional de esta marca no pudo listarse.', count: listingErrors.length, evidence: listingErrors.slice(0, 5),
  });
  return {
    brandId: group.brandId,
    brandName: group.brandName,
    accountIds: group.accounts.map(candidate => String(candidate.id)),
    status: diagnosis.status,
    sample: {
      accountId: account.id,
      accountName: account.name ?? account.id,
      fileName: file.name,
      sourceShopId,
      storeName: sampledStore?.name ?? '',
      city: sampledStore?.city ?? '',
      fileTimestamp: file.fileTimestamp ?? null,
      modifiedAt: file.modifiedAt ?? null,
      size: file.size ?? remote.buffer.length,
      encoding,
      stats: dataset.stats,
    },
    sampleOptions,
    anomalies: diagnosis.anomalies,
  };
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

function automationFileOrder(left, right) {
  const leftDate = String(left.modifiedAt ?? left.fileTimestamp ?? '');
  const rightDate = String(right.modifiedAt ?? right.fileTimestamp ?? '');
  return rightDate.localeCompare(leftDate) || String(right.name).localeCompare(String(left.name));
}

function selectAutomationFiles(files, mode, requestedFileName) {
  const available = files.filter(file => file.loadable).sort(automationFileOrder);
  if (mode === 'specific') {
    const fileName = String(requestedFileName ?? '').trim();
    const selected = available.find(file => file.name === fileName);
    if (!selected) throw new Error('El archivo específico ya no está disponible o no es cargable.');
    return [selected];
  }
  if (mode !== 'latest') throw new Error('El alcance debe ser el archivo más reciente por tienda o un archivo específico.');
  const seen = new Set();
  const selected = [];
  for (const file of available) {
    const sourceShopId = String(file.sourceShopId ?? '').trim();
    if (!sourceShopId || seen.has(sourceShopId)) continue;
    seen.add(sourceShopId);
    selected.push(file);
  }
  if (!selected.length) throw new Error('No se encontraron archivos recientes identificables por tienda.');
  if (selected.length > 1000) throw new Error('La cuenta contiene más de 1000 tiendas; reduce el alcance antes de preparar la operación.');
  return selected;
}

async function downloadAutomationFiles(provider, accountId, files) {
  const downloaded = new Map();
  if (typeof provider.downloadMany === 'function') {
    try {
      const remotes = await provider.downloadMany(files.map(file => file.name), { accountId });
      for (const remote of remotes) downloaded.set(remote.fileName, { remote });
      return downloaded;
    } catch {
      // Fall back per file so one unavailable object does not hide the remaining stores.
    }
  }
  const results = await mapWithConcurrency(files, 4, async file => {
    try {
      return { fileName: file.name, remote: await provider.download(file.name, { accountId }) };
    } catch (error) {
      return { fileName: file.name, error };
    }
  });
  for (const result of results) downloaded.set(result.fileName, result);
  return downloaded;
}

async function loadAutomationDataset(fileName, buffer) {
  try {
    return { ...(await loadDatasetFromBuffer(fileName, buffer, { encoding: 'utf-8' })), encoding: 'utf-8' };
  } catch (error) {
    if (!/no usa utf-8/i.test(safeMessage(error))) throw error;
    return { ...(await loadDatasetFromBuffer(fileName, buffer, { encoding: 'windows-1252' })), encoding: 'windows-1252' };
  }
}

function automationStore(accountId, sourceShopId, availableStores) {
  return availableStores.find(store => store.sftpAccountId === accountId
    && (String(store.appShopId) === sourceShopId || String(store.shopId) === sourceShopId));
}

function automationEntryView(entry) {
  return {
    fileName: entry.file.name,
    sourceShopId: entry.sourceShopId ?? String(entry.file.sourceShopId ?? ''),
    fileTimestamp: entry.file.fileTimestamp ?? null,
    modifiedAt: entry.file.modifiedAt ?? null,
    status: entry.status,
    message: entry.message ?? '',
    store: entry.store ? {
      id: entry.store.id,
      name: entry.store.name,
      appShopId: entry.store.appShopId,
      shopId: entry.store.shopId,
      city: entry.store.city ?? '',
    } : null,
    writeEligible: entry.writeEligible === true,
    sendEligible: entry.sendEligible === true,
    originalSha256: entry.originalSha256 ?? null,
    editedSha256: entry.editedSha256 ?? null,
    changedRows: entry.changedRows ?? 0,
    encoding: entry.encoding ?? null,
    types: entry.types ?? [],
    rules: entry.rules ?? null,
    promotions: entry.plan?.totals?.promotions ?? 0,
    items: entry.plan?.totals?.items ?? 0,
    requests: entry.plan?.totals?.requests ?? 0,
    activityIdMappings: entry.plan?.selection?.activityIdReplacement?.mappings ?? [],
  };
}

function combinedAutomationPlan(entries, selection) {
  const planned = entries.filter(entry => entry.sendEligible && entry.plan);
  const jobs = planned.flatMap(entry => entry.plan.jobs);
  return {
    jobs,
    stores: planned.flatMap(entry => entry.plan.stores),
    warnings: planned.flatMap(entry => entry.plan.warnings ?? []),
    selection,
    totals: {
      stores: planned.length,
      requests: jobs.length,
      promotions: planned.reduce((total, entry) => total + entry.plan.totals.promotions, 0),
      promotionsBeforeGrouping: planned.reduce((total, entry) => total + entry.plan.totals.promotionsBeforeGrouping, 0),
      items: planned.reduce((total, entry) => total + entry.plan.totals.items, 0),
      actions: {
        create: planned.reduce((total, entry) => total + entry.plan.totals.actions.create, 0),
        stop: planned.reduce((total, entry) => total + entry.plan.totals.actions.stop, 0),
      },
    },
  };
}

async function prepareSftpAutomation({ body, provider, runtimeConfig, auditRoot }) {
  const accountId = String(body.accountId ?? '').trim();
  const accounts = typeof provider.listPromotionAccounts === 'function' ? await provider.listPromotionAccounts() : [];
  const account = accounts.find(candidate => String(candidate.id) === accountId);
  if (!account) throw new Error('Selecciona una cuenta SFTP de promociones configurada.');
  const fileMode = String(body.fileMode ?? 'latest');
  const types = Array.isArray(body.types) ? [...new Set(body.types.map(Number))] : [];
  if (!types.length || types.some(type => ![2, 4, 8].includes(type))) throw new Error('Selecciona tipo 2, 4 u 8.');
  const updateDates = body.updateDates === true;
  const dates = updateDates ? normalizeAutomationDates(body) : { startDate: null, endDate: null };
  if (updateDates && !dates.startDate && !dates.endDate) throw new Error('Indica al menos una fecha para modificar la vigencia.');
  const writeSftp = body.writeSftp === true;
  const sendApi = body.sendApi !== false;
  if (!writeSftp && !sendApi) throw new Error('Selecciona editar el SFTP, enviar a la API o ambas operaciones.');
  if (writeSftp && !updateDates) throw new Error('Para editar el SFTP debes activar el cambio de vigencia.');
  const newActivityId = String(body.newActivityId ?? '').trim();
  if (sendApi && !/^\d{1,64}$/.test(newActivityId)) throw new Error('El nuevo Activity ID debe contener entre 1 y 64 dígitos.');
  const files = selectAutomationFiles(
    await provider.listFiles({ force: body.refresh === true, accountId }),
    fileMode,
    body.fileName,
  );
  const downloads = await downloadAutomationFiles(provider, accountId, files);
  const entries = await mapWithConcurrency(files, 4, async file => {
    const downloaded = downloads.get(file.name);
    if (!downloaded?.remote) return { file, status: 'blocked', message: safeMessage(downloaded?.error ?? 'No se pudo descargar el archivo.') };
    const originalBuffer = downloaded.remote.buffer;
    const originalSha256 = createHash('sha256').update(originalBuffer).digest('hex');
    try {
      let encoding = 'utf-8';
      if (!updateDates) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(originalBuffer); }
        catch { encoding = 'windows-1252'; }
      }
      let rewritten;
      if (updateDates) {
        try {
          rewritten = rewritePromotionDates(originalBuffer, file.name, { ...dates, encoding });
        } catch (error) {
          if (!/no se pudo leer usando utf-8/i.test(safeMessage(error))) throw error;
          encoding = 'windows-1252';
          rewritten = rewritePromotionDates(originalBuffer, file.name, { ...dates, encoding });
        }
      } else {
        rewritten = { buffer: originalBuffer, changedRows: 0, encoding };
      }
      const loaded = await loadAutomationDataset(file.name, rewritten.buffer);
      encoding = loaded.encoding;
      const sourceShops = loaded.dataset.stats.sourceShops ?? [];
      if (sourceShops.length !== 1) throw new Error(`El archivo contiene ${sourceShops.length} tiendas origen; se requiere exactamente una.`);
      const sourceShopId = String(sourceShops[0]);
      if (file.sourceShopId && String(file.sourceShopId) !== sourceShopId) {
        throw new Error(`El nombre identifica la tienda ${file.sourceShopId}, pero el contenido usa ${sourceShopId}.`);
      }
      const store = automationStore(accountId, sourceShopId, runtimeConfig.stores);
      if (!store) throw new Error(`La tienda ${sourceShopId} no está vinculada a la marca seleccionada.`);
      const prepared = prepareDatasetForAutomation(loaded.dataset, types);
      const writeEligible = writeSftp && updateDates;
      if (!prepared.dataset.promotions.length) {
        return {
          file, sourceShopId, store, originalBuffer, editedBuffer: rewritten.buffer,
          originalSha256, editedSha256: createHash('sha256').update(rewritten.buffer).digest('hex'),
          changedRows: rewritten.changedRows, encoding, types: [], rules: prepared.rules,
          writeEligible, sendEligible: false,
          status: writeEligible ? 'ready' : 'skipped',
          message: `No contiene promociones de tipo ${types.join(', ')}.`,
        };
      }
      let plan = null;
      if (sendApi) {
        const activityIds = [...new Set(prepared.dataset.promotions.map(promotion => String(promotion.payload.activity_id)))];
        ({ plan } = makePlan({ dataset: prepared.dataset }, {
          sftpAccountId: accountId,
          destinationMode: 'selected',
          storeIds: [store.id],
          activityIds,
          types,
          activityAction: 1,
          appItemIdType: store.appItemIdType,
          groupSameTypeAndValidity: true,
          idMode: 'manual',
          newActivityId,
        }, runtimeConfig));
      }
      return {
        file, sourceShopId, store, originalBuffer, editedBuffer: rewritten.buffer,
        originalSha256, editedSha256: createHash('sha256').update(rewritten.buffer).digest('hex'),
        changedRows: rewritten.changedRows, encoding,
        types: automationTypeSummary(prepared.dataset), rules: prepared.rules, plan,
        writeEligible, sendEligible: Boolean(plan), status: 'ready', message: '',
      };
    } catch (error) {
      return { file, originalBuffer, originalSha256, status: 'blocked', message: safeMessage(error), writeEligible: false, sendEligible: false };
    }
  });
  const ready = entries.filter(entry => entry.status === 'ready');
  const selection = {
    mode: 'sftp_automation', accountId, accountName: account.name, fileMode,
    types, newActivityId: sendApi ? newActivityId : null,
    dates, operations: { writeSftp, sendApi },
    rules: {
      mostRecentFilePerStore: fileMode === 'latest',
      groupSameTypeAndValidity: true,
      omitZeroPercent: true,
      omitPercentOutsideFiveToNinetyNine: true,
      blockConflictingDuplicateUpc: true,
    },
  };
  const plan = combinedAutomationPlan(entries, selection);
  const stores = [...new Map(entries.filter(entry => entry.sendEligible).map(entry => [entry.store.id, entry.store])).values()];
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const compositeHash = createHash('sha256');
  for (const entry of entries) compositeHash.update(`${entry.file.name}\0${entry.originalSha256 ?? ''}\n`);
  const session = {
    id: randomUUID(), fileName: `${accountId}-${fileMode}`,
    sha256: compositeHash.digest('hex'), createdAt,
    dataset: {
      meta: { fileName: `${accountId}-${fileMode}`, format: 'sftp-automation' },
      stats: { rows: 0, promotions: plan.totals.promotions, items: plan.totals.items, sourceShops: entries.map(entry => entry.sourceShopId).filter(Boolean), byType: {} },
      warnings: [], promotions: [],
    },
  };
  const preview = { id, sessionId: session.id, plan, stores, createdAt, attempted: false, entries, selection };
  preview.audit = await createPreviewAudit(preview, session, auditRoot, accountId);
  const fileViews = entries.map(automationEntryView);
  preview.audit.manifest.automation = {
    ...selection,
    summary: {
      selectedFiles: entries.length,
      readyFiles: ready.length,
      blockedFiles: entries.filter(entry => entry.status === 'blocked').length,
      skippedFiles: entries.filter(entry => entry.status === 'skipped').length,
      filesToEdit: entries.filter(entry => entry.writeEligible).length,
      storesToSend: entries.filter(entry => entry.sendEligible).length,
    },
    files: fileViews,
  };
  await writePrivateJson(path.join(preview.audit.directory, 'manifest.json'), preview.audit.manifest);
  await appendAuditEvent(preview.audit.directory, { event: 'sftp_automation_preview_generated', previewId: id, selectedFiles: entries.length, readyFiles: ready.length });
  sftpAutomationPreviews.set(id, preview);
  prune(sftpAutomationPreviews, MAX_AUTOMATION_PREVIEWS);
  return {
    previewId: id,
    createdAt,
    auditDirectory: preview.audit.directory,
    executable: ready.length > 0,
    selection,
    summary: preview.audit.manifest.automation.summary,
    totals: plan.totals,
    files: fileViews,
    samplePayloads: plan.jobs.slice(0, 3).map(job => ({ store: auditStore(job.store), batchNumber: job.batchNumber, payload: job.payload })),
  };
}

async function resolveAutomationTokens(stores, provider) {
  const tokens = new Map();
  const errors = new Map();
  const resolveGroup = async group => {
    if (!group.length) return;
    try {
      const resolved = await resolveTokens(group, '', provider);
      for (const store of group) tokens.set(store.id, resolved.get(store.id));
    } catch (error) {
      if (group.length === 1) {
        errors.set(group[0].id, safeMessage(error));
        return;
      }
      const middle = Math.ceil(group.length / 2);
      await resolveGroup(group.slice(0, middle));
      await resolveGroup(group.slice(middle));
    }
  };
  for (let index = 0; index < stores.length; index += 100) await resolveGroup(stores.slice(index, index + 100));
  const storeByToken = new Map();
  for (const store of stores) {
    const token = tokens.get(store.id);
    if (!token) continue;
    const previous = storeByToken.get(token);
    if (previous) {
      const message = `La autenticación de ${store.name} coincide con ${previous.name}; ambas tiendas se omitieron por seguridad.`;
      errors.set(store.id, message);
      errors.set(previous.id, message);
      tokens.delete(store.id);
      tokens.delete(previous.id);
    } else {
      storeByToken.set(token, store);
    }
  }
  return { tokens, errors };
}

async function executeSftpAutomation({ preview, provider, apiUrl, fetchImpl }) {
  const { writeSftp, sendApi } = preview.selection.operations;
  const readyEntries = preview.entries.filter(entry => entry.status === 'ready');
  if (!readyEntries.length) throw new Error('La vista previa no contiene archivos listos para ejecutar.');
  if (writeSftp && typeof provider.replacePromotionFile !== 'function') {
    throw new Error('La conexión configurada permite leer, pero no editar archivos SFTP.');
  }
  if (sendApi && !apiUrl) throw new Error(`Falta ${config.api.urlEnv} en .env.`);
  const plannedEntries = readyEntries.filter(entry => entry.sendEligible);
  const plannedStores = [...new Map(plannedEntries.map(entry => [entry.store.id, entry.store])).values()];
  let tokenEnvironment = null;
  let tokenResolution = { tokens: new Map(), errors: new Map() };
  if (sendApi && plannedStores.length) {
    tokenResolution = await resolveAutomationTokens(plannedStores, provider);
    tokenEnvironment = { ...process.env };
    for (const store of plannedStores) {
      const token = tokenResolution.tokens.get(store.id);
      if (token) tokenEnvironment[store.authTokenEnv] = token;
    }
    await appendAuditEvent(preview.audit.directory, {
      event: 'sftp_automation_authentication_resolved',
      previewId: preview.id,
      storeIds: [...tokenResolution.tokens.keys()],
      failures: [...tokenResolution.errors].map(([storeId, message]) => ({ storeId, message })),
    });
  }
  preview.attempted = true;
  await updateAuditManifest(preview, { status: 'automation_running', executionStartedAt: new Date().toISOString() });
  const writeResults = new Map();
  if (writeSftp) {
    const mutations = await mapWithConcurrency(readyEntries.filter(entry => entry.writeEligible
      && (!entry.sendEligible || tokenResolution.tokens.has(entry.store.id))), 3, async entry => {
      try {
        const result = await provider.replacePromotionFile(
          preview.selection.accountId,
          entry.file.name,
          entry.editedBuffer,
          { expectedSha256: entry.originalSha256, operationId: preview.id },
        );
        await appendAuditEvent(preview.audit.directory, {
          event: 'sftp_file_replaced', previewId: preview.id, fileName: entry.file.name,
          storeId: entry.store?.id ?? null, backupPath: result.backupPath ?? null,
          originalSha256: result.originalSha256, editedSha256: result.editedSha256,
          unchanged: result.unchanged === true,
        });
        return { fileName: entry.file.name, status: result.unchanged ? 'unchanged' : 'updated', ...result };
      } catch (error) {
        const result = { fileName: entry.file.name, status: 'failed', message: safeMessage(error) };
        await appendAuditEvent(preview.audit.directory, { event: 'sftp_file_replace_failed', previewId: preview.id, ...result });
        return result;
      }
    });
    for (const result of mutations) writeResults.set(result.fileName, result);
  }
  const sendEntries = plannedEntries.filter(entry => {
    if (!tokenResolution.tokens.has(entry.store.id)) return false;
    if (!writeSftp || !entry.writeEligible) return true;
    return ['updated', 'unchanged'].includes(writeResults.get(entry.file.name)?.status);
  });
  const skippedAuthentication = plannedEntries.filter(entry => !tokenResolution.tokens.has(entry.store.id)).length;
  const skippedAfterWriteFailure = plannedEntries.length - sendEntries.length - skippedAuthentication;
  let uploadOutcome = {
    results: [], acceptedBatches: 0, rejectedBatches: 0, unknownBatches: 0,
    stopped: false, skippedBatches: skippedAfterWriteFailure,
  };
  if (sendApi && sendEntries.length) {
    uploadOutcome = await uploadJobs(sendEntries.flatMap(entry => entry.plan.jobs), {
      ...config.api,
      apiUrl,
      env: tokenEnvironment,
      fetchImpl,
      continueOnFailure: true,
      onResult: event => appendAuditEvent(preview.audit.directory, { event: 'sftp_automation_upload_batch', ...event }),
      log() {},
    });
    uploadOutcome.skippedBatches = skippedAfterWriteFailure;
  }
  const result = {
    previewId: preview.id,
    accountId: preview.selection.accountId,
    sftp: {
      requested: writeSftp,
      updatedFiles: [...writeResults.values()].filter(item => item.status === 'updated').length,
      unchangedFiles: [...writeResults.values()].filter(item => item.status === 'unchanged').length,
      failedFiles: [...writeResults.values()].filter(item => item.status === 'failed').length,
      results: [...writeResults.values()],
    },
    api: {
      requested: sendApi,
      skippedAuthentication,
      authenticationFailures: [...tokenResolution.errors].map(([storeId, message]) => ({
        storeId,
        storeName: plannedStores.find(store => store.id === storeId)?.name ?? storeId,
        message,
      })),
      skippedAfterWriteFailure,
      ...uploadOutcome,
    },
    outputDirectory: preview.audit.directory,
  };
  await writePrivateJson(path.join(preview.audit.directory, 'result.json'), result);
  await appendAuditEvent(preview.audit.directory, {
    event: 'sftp_automation_completed', previewId: preview.id,
    updatedFiles: result.sftp.updatedFiles, failedFiles: result.sftp.failedFiles,
    acceptedBatches: uploadOutcome.acceptedBatches, rejectedBatches: uploadOutcome.rejectedBatches,
    unknownBatches: uploadOutcome.unknownBatches, skippedAuthentication, skippedAfterWriteFailure,
  });
  await updateAuditManifest(preview, {
    status: result.sftp.failedFiles || uploadOutcome.rejectedBatches || uploadOutcome.unknownBatches
      ? 'automation_completed_with_incidents' : 'automation_completed',
    executionCompletedAt: new Date().toISOString(),
    executionSummary: {
      updatedFiles: result.sftp.updatedFiles,
      unchangedFiles: result.sftp.unchangedFiles,
      failedFiles: result.sftp.failedFiles,
      acceptedBatches: uploadOutcome.acceptedBatches,
      rejectedBatches: uploadOutcome.rejectedBatches,
      unknownBatches: uploadOutcome.unknownBatches,
      skippedAuthentication,
      skippedAfterWriteFailure,
    },
  });
  return result;
}

function automaticDiagnosticsSummary(results) {
  return {
    brands: results.length,
    healthy: results.filter(result => result.status === 'healthy').length,
    warnings: results.filter(result => result.status === 'warning').length,
    critical: results.filter(result => result.status === 'critical').length,
    unavailable: results.filter(result => result.status === 'unavailable').length,
    anomalies: results.reduce((total, result) => total + result.anomalies.length, 0),
  };
}

async function buildAutomaticDiagnostics(sorianaSftp, { force = false, now = new Date() } = {}) {
  const accounts = typeof sorianaSftp.listPromotionAccounts === 'function'
    ? await sorianaSftp.listPromotionAccounts({ force })
    : [];
  const groups = promotionBrandGroups(accounts);
  const results = await mapWithConcurrency(groups, 3, group => diagnosePromotionBrand(group, { sorianaSftp, force, now }));
  return {
    generatedAt: now.toISOString(),
    samplePolicy: 'Un archivo reciente y cargable de una tienda por marca.',
    rules: DIAGNOSTIC_RULES,
    summary: automaticDiagnosticsSummary(results),
    results,
  };
}

export function createPromoServer(options = {}) {
  const sorianaSftp = options.sorianaSftp ?? defaultSorianaSftp;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredApiUrl = options.apiUrl ?? process.env[config.api.urlEnv];
  const auditRoot = path.resolve(options.auditRoot ?? path.join(root, 'output'));
  const diagnosticsCacheMs = options.diagnosticsCacheMs ?? 10 * 60_000;
  const diagnosticsNow = typeof options.diagnosticsNow === 'function' ? options.diagnosticsNow : () => new Date();
  let diagnosticsCache = { loadedAt: 0, value: null };
  let diagnosticsInFlight = null;
  let runtimeConfig = config;
  const promotionStoreOverrides = new Map();
  const applyPromotionStoreOverrides = accounts => accounts.map(account => {
    const override = promotionStoreOverrides.get(String(account.id));
    return override ? { ...account, ...override, id: account.id, name: account.name, filePattern: account.filePattern } : account;
  });
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
      if (request.method === 'POST' && url.pathname === '/api/sftp-accounts/refresh-stores') {
        if (typeof sorianaSftp.fetchPromotionAccountStores !== 'function') {
          throw new Error('La fuente configurada no permite actualizar las tiendas desde DiDi.');
        }
        const body = await readJson(request);
        const accountId = String(body.accountId ?? '').trim();
        const configuredAccounts = typeof sorianaSftp.listPromotionAccounts === 'function'
          ? await sorianaSftp.listPromotionAccounts()
          : [];
        const configured = configuredAccounts.find(account => String(account.id) === accountId);
        if (!configured) throw new Error('Selecciona una cuenta SFTP de promociones configurada.');
        const refreshed = await sorianaSftp.fetchPromotionAccountStores(accountId);
        promotionStoreOverrides.set(accountId, refreshed);
        const accounts = applyPromotionStoreOverrides(configuredAccounts);
        runtimeConfig = { ...config, stores: buildRuntimeStores(accounts) };
        const stores = runtimeConfig.stores.filter(store => store.sftpAccountId === accountId);
        return json(response, 200, {
          accountId,
          brandId: refreshed.brandId,
          brandName: refreshed.brandName,
          stores: stores.length,
          numericAppShopIds: stores.filter(store => /^\d+$/.test(store.appShopId)).length,
          alphanumericAppShopIds: stores.filter(store => !/^\d+$/.test(store.appShopId)).length,
          refreshedAt: new Date().toISOString(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        let promotionAccounts = [];
        if (typeof sorianaSftp.listPromotionAccounts === 'function') {
          try { promotionAccounts = await sorianaSftp.listPromotionAccounts(); }
          catch { promotionAccounts = []; }
        }
        const accounts = applyPromotionStoreOverrides(promotionAccounts.length
          ? promotionAccounts
          : [{ id: 'soriana', name: 'Soriana', brandName: 'Soriana', filePattern: 'promocionesdidi_*.csv', stores: [] }]);
        let legacyRemoteStores = [];
        if (!accounts.some(account => Array.isArray(account.stores) && account.stores.length)
          && typeof sorianaSftp.getStoreDirectory === 'function') {
          try { legacyRemoteStores = (await sorianaSftp.getStoreDirectory()).stores ?? []; }
          catch { legacyRemoteStores = []; }
        }
        runtimeConfig = { ...config, stores: buildRuntimeStores(accounts, legacyRemoteStores) };
        const sftpAccounts = accounts.map(account => {
          const id = String(account.id);
          return {
            id,
            name: String(account.name),
            brandId: String(account.brandId ?? ''),
            brandName: String(account.brandName ?? account.name ?? ''),
            filePattern: String(account.filePattern ?? ''),
            storeCount: runtimeConfig.stores.filter(store => store.sftpAccountId === id).length,
          };
        });
        const stores = runtimeConfig.stores.map(store => ({
          id: store.id,
          name: store.name,
          city: store.city || '',
          shopId: store.shopId,
          appShopId: store.appShopId,
          sourceShopIds: store.sourceShopIds,
          appItemIdType: store.appItemIdType,
          sftpAccountId: store.sftpAccountId,
          brandId: store.brandId,
          brandName: store.brandName,
          tokenConfigured: Boolean((process.env[store.authTokenEnv] ?? '').trim()),
        }));
        return json(response, 200, {
          apiUrl: process.env[config.api.urlEnv] ?? '',
          defaultAppItemIdType: config.defaults.appItemIdType,
          batchSize: config.defaults.batchSize,
          maxItemsPerBatch: config.defaults.maxItemsPerBatch,
          defaultRuleProfiles: ruleProfiles(promotionAccounts),
          sftpAccounts,
          stores,
          cities: [...new Set(stores.map(store => store.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
          sftpConfigured: sorianaSftp.configured,
          automaticStoreAuthentication: sorianaSftp.authConfigured === true,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        const force = url.searchParams.get('refresh') === '1';
        if (!force && diagnosticsCache.value && Date.now() - diagnosticsCache.loadedAt < diagnosticsCacheMs) {
          return json(response, 200, { ...diagnosticsCache.value, cached: true });
        }
        if (!diagnosticsInFlight) {
          diagnosticsInFlight = buildAutomaticDiagnostics(sorianaSftp, { force, now: diagnosticsNow() })
            .then(value => {
              diagnosticsCache = { loadedAt: Date.now(), value };
              return value;
            })
            .finally(() => { diagnosticsInFlight = null; });
        }
        const value = await diagnosticsInFlight;
        return json(response, 200, { ...value, cached: false });
      }
      if (request.method === 'POST' && url.pathname === '/api/diagnostics/sample') {
        const body = await readJson(request);
        const accountId = String(body.accountId ?? '').trim();
        const fileName = String(body.fileName ?? '').trim();
        if (!accountId || !fileName) throw new Error('Selecciona una tienda válida para el diagnóstico.');
        const accounts = typeof sorianaSftp.listPromotionAccounts === 'function'
          ? await sorianaSftp.listPromotionAccounts()
          : [];
        const group = promotionBrandGroups(accounts).find(candidate =>
          candidate.accounts.some(account => String(account.id) === accountId)
        );
        if (!group) throw new Error('La marca elegida ya no está disponible. Actualiza el diagnóstico.');
        const now = diagnosticsNow();
        const result = await diagnosePromotionBrand(group, {
          sorianaSftp, force: false, now, selection: { accountId, fileName },
        });
        if (diagnosticsCache.value) {
          const index = diagnosticsCache.value.results.findIndex(candidate =>
            (result.brandId && candidate.brandId === result.brandId)
            || (!result.brandId && candidate.brandName === result.brandName)
          );
          if (index >= 0) {
            diagnosticsCache.value.results[index] = result;
            diagnosticsCache.value.summary = automaticDiagnosticsSummary(diagnosticsCache.value.results);
            diagnosticsCache.value.generatedAt = now.toISOString();
            diagnosticsCache.loadedAt = Date.now();
          }
        }
        return json(response, 200, { generatedAt: now.toISOString(), rules: DIAGNOSTIC_RULES, result });
      }
      if (request.method === 'POST' && url.pathname === '/api/sftp-automation/preview') {
        const body = await readJson(request);
        return json(response, 200, await prepareSftpAutomation({
          body,
          provider: sorianaSftp,
          runtimeConfig,
          auditRoot,
        }));
      }
      if (request.method === 'POST' && url.pathname === '/api/sftp-automation/execute') {
        const body = await readJson(request);
        if (body.confirmed !== true) throw new Error('Confirma expresamente la edición SFTP y/o el envío a producción.');
        const preview = sftpAutomationPreviews.get(String(body.previewId ?? ''));
        if (!preview) throw new Error('La vista previa SFTP expiró. Genera una nueva.');
        if (preview.attempted) throw new Error('Esta vista previa ya se ejecutó. Genera otra para evitar duplicados.');
        try {
          return json(response, 200, await executeSftpAutomation({
            preview,
            provider: sorianaSftp,
            apiUrl: configuredApiUrl,
            fetchImpl,
          }));
        } catch (error) {
          try { await recordAuditError(preview, preview.attempted ? 'sftp_automation_execution' : 'sftp_automation_authentication', error); }
          catch { /* El error de la operación conserva prioridad. */ }
          error.auditDirectory = preview.audit.directory;
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/sftp-files') {
        const query = String(url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('es');
        const accountId = String(url.searchParams.get('accountId') ?? '').trim();
        const force = url.searchParams.get('refresh') === '1';
        const requestedLimit = Number(url.searchParams.get('limit') ?? 200);
        const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 200;
        const files = await sorianaSftp.listFiles({ force, accountId });
        const matches = query
          ? files.filter(file => file.name.toLocaleLowerCase('es').includes(query) || String(file.sourceShopId ?? '').toLocaleLowerCase('es').includes(query))
          : files;
        return json(response, 200, { total: matches.length, files: matches.slice(0, limit) });
      }
      if (request.method === 'POST' && url.pathname === '/api/sftp-files/load') {
        const body = await readJson(request);
        const remote = await sorianaSftp.download(body.fileName, { accountId: body.accountId });
        return json(response, 200, await parseUploadBuffer(remote.fileName, remote.buffer, body));
      }
      if (request.method === 'GET' && url.pathname === '/api/sftp-files/download') {
        const accountId = String(url.searchParams.get('accountId') ?? '').trim();
        const fileName = String(url.searchParams.get('fileName') ?? '').trim();
        const remote = await sorianaSftp.download(fileName, { accountId });
        return download(response, remote.fileName, remote.buffer);
      }
      if (request.method === 'POST' && url.pathname === '/api/files') {
        return json(response, 200, await parseUpload(await readJson(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/preview') {
        const body = await readJson(request);
        const session = requireSession(body.sessionId);
        const { plan, stores } = makePlan(session, body, runtimeConfig);
        const id = randomUUID();
        const preview = { id, sessionId: session.id, plan, stores, createdAt: new Date().toISOString(), attempted: false };
        preview.audit = await createPreviewAudit(preview, session, auditRoot, body.sftpAccountId);
        previews.set(id, preview);
        prune(previews, MAX_PREVIEWS);
        const allBatchesVisible = stores.length <= 5;
        const visibleJobs = allBatchesVisible
          ? plan.jobs
          : plan.jobs.filter(job => job.store.id === stores[0].id);
        return json(response, 200, {
          previewId: id,
          createdAt: preview.createdAt,
          auditDirectory: preview.audit.directory,
          store: stores.length === 1 ? { id: stores[0].id, name: stores[0].name } : null,
          stores: stores.map(store => ({ id: store.id, name: store.name, shopId: store.shopId, appShopId: store.appShopId })),
          destinationCount: stores.length,
          previewScope: allBatchesVisible ? 'all_destinations' : 'representative_destination',
          selection: plan.selection,
          totals: plan.totals,
          warnings: plan.warnings,
          batches: visibleJobs.map(job => ({
            store: { id: job.store.id, name: job.store.name, appShopId: job.store.appShopId },
            batchNumber: job.batchNumber,
            payload: job.payload,
          })),
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/send') {
        const body = await readJson(request);
        const preview = previews.get(String(body.previewId ?? ''));
        if (!preview) throw new Error('La vista previa expiró. Genera una nueva.');
        if (preview.attempted) throw new Error('Esta vista previa ya tuvo un intento de envío. Genera otra para evitar duplicados.');
        const apiUrl = configuredApiUrl;
        if (!apiUrl) throw new Error(`Falta ${config.api.urlEnv} en .env.`);
        await updateAuditManifest(preview, { status: 'preparing_send' });
        await appendAuditEvent(preview.audit.directory, { event: 'send_preparing', previewId: preview.id });
        try {
          const tokens = await resolveTokens(preview.stores, body.authToken, sorianaSftp);
          const tokenEnvironment = { ...process.env };
          for (const store of preview.stores) tokenEnvironment[store.authTokenEnv] = tokens.get(store.id);
          await appendAuditEvent(preview.audit.directory, {
            event: 'authentication_resolved',
            previewId: preview.id,
            storeIds: preview.stores.map(store => store.id),
          });
          preview.attempted = true;
          await updateAuditManifest(preview, { status: 'sending', sendStartedAt: new Date().toISOString() });
          const outcome = await uploadJobs(preview.plan.jobs, {
            ...config.api,
            apiUrl,
            env: tokenEnvironment,
            fetchImpl,
            continueOnFailure: preview.stores.length > 1,
            onResult: event => appendAuditEvent(preview.audit.directory, { event: 'upload_batch', ...event }),
            log() {},
          });
          await writePrivateJson(path.join(preview.audit.directory, 'result.json'), outcome);
          await appendAuditEvent(preview.audit.directory, {
            event: 'send_completed',
            acceptedBatches: outcome.acceptedBatches,
            rejectedBatches: outcome.rejectedBatches,
            unknownBatches: outcome.unknownBatches,
            stopped: outcome.stopped,
          });
          await updateAuditManifest(preview, {
            status: outcome.stopped ? 'send_stopped' : 'send_completed',
            sendCompletedAt: new Date().toISOString(),
            uploadSummary: {
              acceptedBatches: outcome.acceptedBatches,
              rejectedBatches: outcome.rejectedBatches,
              unknownBatches: outcome.unknownBatches,
              stopped: outcome.stopped,
            },
          });
          return json(response, 200, { ...outcome, outputDirectory: preview.audit.directory });
        } catch (error) {
          try { await recordAuditError(preview, preview.attempted ? 'send' : 'authentication', error); }
          catch { /* El error original conserva prioridad; los archivos previos siguen disponibles. */ }
          error.auditDirectory = preview.audit.directory;
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/query-task') {
        const body = await readJson(request);
        const store = requireStore(body.storeId, runtimeConfig.stores);
        const token = (await resolveTokens([store], body.authToken, sorianaSftp)).get(store.id);
        const taskId = String(body.taskId ?? '').trim();
        if (!/^\d{1,64}$/.test(taskId)) throw new Error('El Task ID debe contener únicamente dígitos.');
        return json(response, 200, await queryPromotionTask({
          store, token, taskId, apiUrl: configuredApiUrl, fetchImpl,
        }));
      }
      if (request.method === 'POST' && url.pathname === '/api/query-tasks/jobs') {
        const body = await readJson(request);
        const tasks = prepareTaskQueries(body.tasks, runtimeConfig.stores);
        pruneTaskQueryJobs();
        const now = Date.now();
        const id = randomUUID();
        const stores = [...new Map(tasks.map(task => [task.store.id, task.store])).values()];
        const job = {
          id,
          status: 'running',
          phase: 'authentication',
          total: tasks.length,
          completed: 0,
          queried: 0,
          errors: 0,
          authBatchesDone: 0,
          authBatchesTotal: Math.ceil(stores.length / MAX_AUTH_TOKEN_BATCH),
          authStoresDone: 0,
          authStoresTotal: stores.length,
          concurrency: Math.min(8, tasks.length),
          createdAtMs: now,
          updatedAtMs: now,
          queryStartedAtMs: null,
          finishedAtMs: null,
          error: '',
          results: new Array(tasks.length),
          updates: [],
        };
        taskQueryJobs.set(id, job);
        pruneTaskQueryJobs();
        void runTaskQueryJob({
          job,
          tasks,
          suppliedToken: body.authToken,
          provider: sorianaSftp,
          apiUrl: configuredApiUrl,
          fetchImpl,
        });
        return json(response, 202, publicTaskQueryJob(job));
      }
      const taskQueryResultMatch = url.pathname.match(/^\/api\/query-tasks\/jobs\/([0-9a-f-]+)\/results\/(\d+)$/i);
      if (request.method === 'GET' && taskQueryResultMatch) {
        pruneTaskQueryJobs();
        const job = taskQueryJobs.get(taskQueryResultMatch[1]);
        if (!job) return json(response, 404, { error: 'La consulta ya no está disponible. Inicia una nueva.' });
        const index = Number(taskQueryResultMatch[2]);
        if (!Number.isSafeInteger(index) || index < 0 || index >= job.total) {
          return json(response, 404, { error: 'El resultado solicitado no existe.' });
        }
        if (!job.results[index]) return json(response, 409, { error: 'Ese Task ID todavía está en proceso.' });
        return json(response, 200, job.results[index]);
      }
      const taskQueryJobMatch = url.pathname.match(/^\/api\/query-tasks\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && taskQueryJobMatch) {
        pruneTaskQueryJobs();
        const job = taskQueryJobs.get(taskQueryJobMatch[1]);
        if (!job) return json(response, 404, { error: 'La consulta ya no está disponible. Inicia una nueva.' });
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(response, 200, publicTaskQueryJob(job, Number.isSafeInteger(after) ? after : 0));
      }
      if (request.method === 'POST' && url.pathname === '/api/query-tasks') {
        const body = await readJson(request);
        const tasks = prepareTaskQueries(body.tasks, runtimeConfig.stores);
        const stores = [...new Map(tasks.map(task => [task.store.id, task.store])).values()];
        const tokens = await resolveTokens(stores, body.authToken, sorianaSftp);
        return json(response, 200, await executeTaskQueries({
          tasks, tokens, apiUrl: configuredApiUrl, fetchImpl,
        }));
      }
      json(response, 404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      json(response, 400, {
        error: safeMessage(error),
        ...(error?.auditDirectory ? { outputDirectory: error.auditDirectory } : {}),
      });
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PROMO_UI_PORT ?? 5373);
  const host = process.env.PROMO_UI_HOST ?? '127.0.0.1';
  const server = createPromoServer();
  server.listen(port, host, () => console.log(`Didi Promo Manager: http://${host}:${port}`));
}
