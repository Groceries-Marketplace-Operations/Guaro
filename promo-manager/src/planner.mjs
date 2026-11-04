import { randomInt } from 'node:crypto';

const SUPPORTED_TYPES = [2, 4, 8];
const ACTIVITY_NAME_LIMIT = 200;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutActivityIdPrefix(name, activityId) {
  const value = String(name ?? '').trim();
  const id = String(activityId ?? '').trim();
  if (!id) return value;
  return value.replace(new RegExp(`^${escapeRegExp(id)}(?:\\s*[·|:\\-]\\s*|\\s+)`, 'u'), '').trim();
}

function generatedActivityName(activityId, name, previousActivityId = activityId) {
  const id = String(activityId).trim();
  const description = withoutActivityIdPrefix(name, previousActivityId) || 'Promoción';
  return `${id} · ${description}`.slice(0, ACTIVITY_NAME_LIMIT);
}

function generatedPromotionPayload(payload) {
  const result = structuredClone(payload);
  result.activity_name = generatedActivityName(result.activity_id, result.activity_name);
  return result;
}

function allowedKeys(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} debe ser un objeto.`);
  const extra = Object.keys(object).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${label}: campos desconocidos ${extra.join(', ')}. Revisa los nombres de la configuración.`);
}

function positiveInteger(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} debe ser un entero entre 1 y ${max}.`);
  }
  return value;
}

function identifiers(value, label, { required = false, wildcard = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error(`Falta ${label}.`);
    return [];
  }
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error(`${label} debe ser un arreglo de cadenas; conserva los IDs entre comillas.`);
  }
  const clean = value.map(v => v.trim());
  if (new Set(clean).size !== clean.length) throw new Error(`${label} contiene IDs repetidos.`);
  if (required && !clean.length) throw new Error(`${label} no puede estar vacío.`);
  if (clean.includes('*') && (!wildcard || clean.length !== 1)) {
    throw new Error(`${label}: usa ["*"] solo para seleccionar expresamente todos los orígenes.`);
  }
  return clean;
}

function types(value, label = 'types') {
  if (!Array.isArray(value) || !value.length || value.some(t => !SUPPORTED_TYPES.includes(t))) {
    throw new Error(`${label} debe contener 2, 4 u 8 como números.`);
  }
  return [...new Set(value)];
}

function itemIdType(value) {
  if (![0, 1].includes(value)) throw new Error('appItemIdType debe ser 0 o 1, según tu catálogo/API.');
  return value;
}

function replacementActivityId(value, label = 'nuevo ActivityID') {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,64}$/.test(id)) {
    throw new Error(`${label} debe contener únicamente entre 1 y 64 dígitos.`);
  }
  return id;
}

function replacementItemId(value, label) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,64}$/.test(id)) {
    throw new Error(`${label} debe contener únicamente entre 1 y 64 dígitos.`);
  }
  return id;
}

function randomNumericId(length) {
  const safeLength = Math.max(1, Math.min(length, 64));
  let value = String(randomInt(1, 10));
  while (value.length < safeLength) value += String(randomInt(0, 10));
  return value;
}

function groupedPromotionKey(promotion) {
  const payload = promotion.payload;
  return JSON.stringify([
    promotion.sourceShopId,
    payload.action,
    payload.activity_type,
    payload.child_type ?? null,
    payload.start_date,
    payload.end_date,
  ]);
}

function groupedActivityId(sourceIds, reserved, options) {
  const signature = sourceIds.join('|');
  const remembered = options.idMap?.get(signature);
  if (remembered) return remembered;
  const length = Math.max(9, ...sourceIds.map(id => String(id).length));
  const factory = options.randomIdFactory ?? ((_ids, _attempt) => randomNumericId(length));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = replacementActivityId(String(factory(sourceIds, attempt)), 'ActivityID agrupado');
    if (reserved.has(candidate)) continue;
    reserved.add(candidate);
    options.idMap?.set(signature, candidate);
    return candidate;
  }
  throw new Error(`No se pudo generar un ActivityID único para agrupar ${sourceIds.join(', ')}.`);
}

/**
 * Consolida promociones que comparten tienda origen, acción, tipo/subtipo y
 * vigencia exacta. Los grupos de dos o más promociones reciben un ActivityID
 * nuevo para no sobrescribir ninguno de los eventos de origen.
 */
export function groupPromotionsByTypeAndValidity(promotions, options = {}) {
  const buckets = new Map();
  for (const promotion of promotions) {
    const key = groupedPromotionKey(promotion);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(promotion);
  }
  const reserved = options.reservedIds instanceof Set
    ? options.reservedIds
    : new Set((options.reservedIds ?? []).map(String));
  const result = [];
  const groups = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      result.push(bucket[0]);
      continue;
    }
    const sourceActivityIds = bucket.map(promotion => String(promotion.payload.activity_id));
    const activityId = groupedActivityId(sourceActivityIds, reserved, options);
    const first = structuredClone(bucket[0]);
    const items = new Map();
    for (const promotion of bucket) {
      for (const item of promotion.payload.item_activity_list) {
        const itemId = String(item.app_item_id);
        const serialized = JSON.stringify(item);
        const previous = items.get(itemId);
        if (previous && previous.serialized !== serialized) {
          throw new Error(
            `No se pueden agrupar ${sourceActivityIds.join(', ')}: el producto ${itemId} tiene mecánicas distintas.`,
          );
        }
        if (!previous) items.set(itemId, { serialized, item: structuredClone(item) });
      }
    }
    first.payload.activity_id = activityId;
    first.payload.activity_name = `AGRUPADA · ${bucket.length} PROMOS · ${first.payload.activity_name}`.slice(0, 200);
    first.payload.item_activity_list = [...items.values()].map(value => value.item);
    first.sourceRows = [...new Set(bucket.flatMap(promotion => promotion.sourceRows ?? []))];
    result.push(first);
    groups.push({
      activityId,
      sourceActivityIds,
      sourceShopId: first.sourceShopId,
      type: first.payload.activity_type,
      childType: first.payload.child_type ?? null,
      startDate: first.payload.start_date,
      endDate: first.payload.end_date,
      items: first.payload.item_activity_list.length,
    });
  }
  return { promotions: result, groups };
}

/**
 * Reemplaza IDs después de aplicar los filtros. El ID original sigue siendo el
 * que se usa con --ids; únicamente cambia el activity_id del JSON generado.
 */
export function replacePlannedActivityIds(plan, options = {}) {
  const manualId = options.manualId;
  const useRandom = options.random === true;
  if (manualId !== undefined && useRandom) throw new Error('Usa --new-id o --random-id, no ambos.');
  if (manualId === undefined && !useRandom) return plan;
  if (!plan?.jobs?.length) throw new Error('No hay promociones planeadas para cambiar su ActivityID.');

  const originalIds = [...new Set(plan.jobs.flatMap(job => job.payload.promo_list
    .filter(promotion => promotion.action !== 2)
    .map(promotion => String(promotion.activity_id))))];
  if (!originalIds.length) throw new Error('No hay promociones con action 1 para cambiar su ActivityID.');
  const reserved = new Set([...(options.reservedIds ?? []).map(String), ...originalIds]);
  const mapping = new Map();

  if (manualId !== undefined) {
    if (originalIds.length !== 1) {
      throw new Error(`--new-id requiere exactamente una promoción seleccionada; actualmente hay ${originalIds.length}.`);
    }
    const replacement = replacementActivityId(manualId);
    if (replacement === originalIds[0]) throw new Error('El nuevo ActivityID debe ser diferente del ID original.');
    if (reserved.has(replacement)) throw new Error(`El nuevo ActivityID ${replacement} ya existe en el archivo origen.`);
    mapping.set(originalIds[0], replacement);
  } else {
    const factory = options.randomIdFactory ?? (original => randomNumericId(original.length));
    for (const original of originalIds) {
      let replacement = '';
      for (let attempt = 0; attempt < 100; attempt += 1) {
        replacement = replacementActivityId(String(factory(original, attempt)), 'ActivityID aleatorio');
        if (!reserved.has(replacement)) break;
        replacement = '';
      }
      if (!replacement) throw new Error(`No se pudo generar un ActivityID aleatorio único para ${original}.`);
      mapping.set(original, replacement);
      reserved.add(replacement);
    }
  }

  for (const job of plan.jobs) {
    for (const promotion of job.payload.promo_list) {
      const originalId = String(promotion.activity_id);
      const replacement = mapping.get(originalId);
      if (replacement) {
        promotion.activity_name = generatedActivityName(replacement, promotion.activity_name, originalId);
        promotion.activity_id = replacement;
      }
    }
  }
  plan.selection.activityIdReplacement = {
    mode: useRandom ? 'random' : 'manual',
    mappings: [...mapping].map(([originalId, sentId]) => ({ originalId, sentId })),
  };
  return plan;
}

/**
 * Reemplaza UPC/app_item_id después de filtrar y agrupar. El cambio se aplica
 * a cada destino del plan y rechaza cualquier colisión dentro de una promoción.
 */
export function replacePlannedItemIds(plan, replacements = []) {
  if (replacements === undefined || replacements === null || replacements.length === 0) return plan;
  if (!Array.isArray(replacements) || replacements.length > 5000) {
    throw new Error('Los cambios de UPC deben ser un arreglo de hasta 5000 elementos.');
  }
  if (!plan?.jobs?.length) throw new Error('No hay promociones planeadas para cambiar UPC.');

  const mapping = new Map();
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
      throw new Error(`El cambio de UPC ${index + 1} no es válido.`);
    }
    const originalId = replacementItemId(replacement.originalId, `UPC original ${index + 1}`);
    const sentId = replacementItemId(replacement.sentId, `UPC nuevo ${index + 1}`);
    if (originalId === sentId) throw new Error(`El UPC nuevo debe ser diferente de ${originalId}.`);
    if (mapping.has(originalId)) throw new Error(`El UPC ${originalId} aparece más de una vez en los cambios.`);
    mapping.set(originalId, sentId);
  }

  const available = new Set(plan.jobs.flatMap(job =>
    job.payload.promo_list.flatMap(promotion =>
      (promotion.item_activity_list ?? []).map(item => String(item.app_item_id))
    )
  ));
  for (const originalId of mapping.keys()) {
    if (!available.has(originalId)) throw new Error(`El UPC ${originalId} no existe en las promociones seleccionadas.`);
  }

  const occurrences = new Map([...mapping.keys()].map(id => [id, 0]));
  for (const job of plan.jobs) {
    for (const promotion of job.payload.promo_list) {
      if (!Array.isArray(promotion.item_activity_list)) continue;
      const resultingIds = new Set();
      for (const item of promotion.item_activity_list) {
        const originalId = String(item.app_item_id);
        const sentId = mapping.get(originalId) ?? originalId;
        if (resultingIds.has(sentId)) {
          throw new Error(`El cambio de UPC produciría el identificador duplicado ${sentId} en la promoción ${promotion.activity_id}.`);
        }
        resultingIds.add(sentId);
        if (mapping.has(originalId)) {
          item.app_item_id = sentId;
          occurrences.set(originalId, occurrences.get(originalId) + 1);
        }
      }
    }
  }
  plan.selection.itemIdReplacement = {
    mappings: [...mapping].map(([originalId, sentId]) => ({
      originalId,
      sentId,
      occurrences: occurrences.get(originalId),
    })),
  };
  return plan;
}

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('La configuración debe ser un objeto JSON.');
  allowedKeys(raw, ['api', 'defaults', 'stores'], 'configuración');
  const d = raw.defaults ?? {};
  const a = raw.api ?? {};
  allowedKeys(d, ['types', 'batchSize', 'maxItemsPerBatch', 'appItemIdType', 'moneyUnit'], 'defaults');
  allowedKeys(a, ['urlEnv', 'timeoutMs', 'delayMs', 'responseSuccessPath', 'responseSuccessValue'], 'api');
  const result = {
    api: {
      urlEnv: a.urlEnv ?? 'PROMO_API_URL',
      timeoutMs: a.timeoutMs ?? 30000,
      delayMs: a.delayMs ?? 500,
      responseSuccessPath: a.responseSuccessPath ?? 'errno',
      responseSuccessValue: a.responseSuccessValue ?? 0,
    },
    defaults: {
      types: types(d.types ?? [4, 8], 'defaults.types'),
      batchSize: positiveInteger(d.batchSize ?? 499, 'defaults.batchSize', 499),
      maxItemsPerBatch: positiveInteger(d.maxItemsPerBatch ?? 5999, 'defaults.maxItemsPerBatch', 5999),
      appItemIdType: itemIdType(d.appItemIdType ?? 0),
      moneyUnit: d.moneyUnit ?? 'pesos',
    },
    stores: [],
  };
  if (!['pesos', 'cents'].includes(result.defaults.moneyUnit)) throw new Error('moneyUnit debe ser pesos o cents.');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.api.urlEnv)) throw new Error('api.urlEnv debe ser un nombre de variable de entorno.');
  positiveInteger(result.api.timeoutMs, 'api.timeoutMs', 300000);
  if (!Number.isSafeInteger(result.api.delayMs) || result.api.delayMs < 0 || result.api.delayMs > 60000) throw new Error('api.delayMs debe estar entre 0 y 60000.');
  if (typeof result.api.responseSuccessPath !== 'string' || !result.api.responseSuccessPath) throw new Error('api.responseSuccessPath no puede estar vacío.');
  if (!Array.isArray(raw.stores ?? [])) throw new Error('stores debe ser un arreglo.');
  const seen = new Set();
  for (const store of raw.stores ?? []) {
    if (!store || typeof store.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(store.id)) {
      throw new Error('Cada tienda necesita un id de texto: letras, números, guion, punto o guion bajo.');
    }
    if (seen.has(store.id.toLowerCase())) throw new Error(`Tienda repetida: ${store.id}.`);
    seen.add(store.id.toLowerCase());
    if (Object.hasOwn(store, 'auth_token') || Object.hasOwn(store, 'token') || Object.hasOwn(store, 'authToken')) {
      throw new Error(`Tienda ${store.id}: coloca el token en .env y usa authTokenEnv.`);
    }
    allowedKeys(store, ['id', 'name', 'city', 'shopId', 'appShopId', 'authTokenEnv', 'appItemIdType', 'sourceShopIds', 'includeActivityIds', 'excludeActivityIds', 'types'], `tienda ${store.id}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(store.authTokenEnv ?? '')) throw new Error(`authTokenEnv inválido para ${store.id}.`);
    const normalized = {
      id: store.id,
      name: typeof store.name === 'string' && store.name.trim() ? store.name : store.id,
      city: typeof store.city === 'string' && store.city.trim() ? store.city.trim() : '',
      shopId: typeof store.shopId === 'string' ? store.shopId.trim() : '',
      appShopId: typeof store.appShopId === 'string' ? store.appShopId.trim() : '',
      authTokenEnv: store.authTokenEnv,
      appItemIdType: itemIdType(store.appItemIdType ?? result.defaults.appItemIdType),
      sourceShopIds: identifiers(store.sourceShopIds, `${store.id}.sourceShopIds`, { required: true, wildcard: true }),
      includeActivityIds: identifiers(store.includeActivityIds, `${store.id}.includeActivityIds`),
      excludeActivityIds: identifiers(store.excludeActivityIds, `${store.id}.excludeActivityIds`),
      ...(store.types === undefined ? {} : { types: types(store.types, `${store.id}.types`) }),
    };
    result.stores.push(normalized);
  }
  return result;
}

export function makePreviewConfig(sourceShopIds, defaults = {}) {
  return normalizeConfig({
    defaults,
    stores: sourceShopIds.map((source, i) => ({
      id: `origen_${i + 1}`,
      name: `Origen ${source} (vista previa)`,
      authTokenEnv: `DIDI_TOKEN_ORIGEN_${i + 1}`,
      sourceShopIds: [source],
    })),
  });
}

function checkKnown(requested, available, label) {
  const missing = requested.filter(id => !available.has(id));
  if (missing.length) throw new Error(`${label} no encontrados: ${missing.join(', ')}.`);
}

function activityActions(value, selectedIds, availableIds, fallback) {
  if (![1, 2].includes(fallback)) throw new Error('activityAction debe ser 1 (crear) o 2 (detener).');
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('activityActions debe ser un arreglo de hasta 10000 promociones.');
  }
  const result = new Map();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`activityActions ${index + 1} no es válido.`);
    const id = typeof entry.activityId === 'string' ? entry.activityId.trim() : '';
    const action = Number(entry.action);
    if (!id || !availableIds.has(id)) throw new Error(`ActivityID de activityActions no encontrado: ${id || '(vacío)'}.`);
    if (selectedIds.length && !selectedIds.includes(id)) throw new Error(`activityActions incluye ${id}, pero esa promoción no está seleccionada.`);
    if (![1, 2].includes(action)) throw new Error(`La acción de ${id} debe ser 1 (crear) o 2 (detener).`);
    if (result.has(id)) throw new Error(`activityActions contiene el ActivityID repetido ${id}.`);
    result.set(id, action);
  }
  return result;
}

function splitActionBatches(promotions, maxPromotions, maxItems) {
  const batches = [];
  let current = [];
  let itemCount = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    itemCount = 0;
  };
  for (const promotion of promotions) {
    const stopping = promotion.payload.action === 2;
    const items = stopping ? 0 : promotion.payload.item_activity_list?.length;
    if (!stopping && (!Number.isSafeInteger(items) || items < 1)) {
      throw new Error(`La promoción ${promotion.payload.activity_id} debe contener al menos un producto.`);
    }
    if (stopping) {
      if (current.length >= maxPromotions) flush();
      current.push(promotion);
      continue;
    }
    const allItems = promotion.payload.item_activity_list;
    let offset = 0;
    while (offset < allItems.length) {
      if (current.length >= maxPromotions || itemCount >= maxItems) flush();
      const availableItems = maxItems - itemCount;
      const end = Math.min(offset + availableItems, allItems.length);
      const chunkItems = allItems.slice(offset, end);
      current.push(offset === 0 && end === allItems.length ? promotion : {
        ...promotion,
        payload: { ...promotion.payload, item_activity_list: chunkItems },
      });
      itemCount += chunkItems.length;
      offset = end;
      if (offset < allItems.length) flush();
    }
  }
  flush();
  return batches;
}

export function buildPlan(dataset, config, selection = {}) {
  if (!dataset?.promotions?.length) throw new Error('El archivo no contiene promociones.');
  if (!config.stores.length) throw new Error('Configura al menos una tienda destino.');
  for (const field of ['ids', 'storeIds', 'sourceShopIds']) {
    if (Array.isArray(selection[field]) && selection[field].length === 0) {
      throw new Error(`${field}: la selección explícita está vacía. Omite el filtro para seleccionar todos.`);
    }
  }
  const selectedTypes = types(selection.types ?? config.defaults.types);
  const selectedIds = identifiers(selection.ids, 'IDs seleccionados');
  const excludedIds = identifiers(selection.excludeIds, 'IDs excluidos');
  const selectedSources = identifiers(selection.sourceShopIds, 'Tiendas origen');
  const requestedStores = identifiers(selection.storeIds, 'Tiendas destino');
  const size = positiveInteger(selection.batchSize ?? config.defaults.batchSize, 'batchSize', 499);
  const maxItems = positiveInteger(selection.maxItemsPerBatch ?? config.defaults.maxItemsPerBatch, 'maxItemsPerBatch', 5999);
  const activityAction = Number(selection.activityAction ?? 1);
  const allIds = new Set(dataset.promotions.map(p => p.payload.activity_id));
  const actionOverrides = activityActions(selection.activityActions, selectedIds, allIds, activityAction);
  const allSources = new Set(dataset.promotions.map(p => p.sourceShopId));
  checkKnown(selectedIds, allIds, 'ActivityID seleccionados');
  checkKnown(excludedIds, allIds, 'ActivityID excluidos');
  checkKnown(selectedSources, allSources, 'Tiendas origen');
  checkKnown(requestedStores, new Set(config.stores.map(s => s.id)), 'Tiendas destino');
  const destinations = requestedStores.length ? config.stores.filter(s => requestedStores.includes(s.id)) : config.stores;
  const query = (selection.search ?? '').toLocaleLowerCase('es');
  const sharedSelection = dataset.promotions.filter(p =>
    selectedTypes.includes(p.payload.activity_type) &&
    (!selectedIds.length || selectedIds.includes(p.payload.activity_id)) &&
    !excludedIds.includes(p.payload.activity_id) &&
    (!selectedSources.length || selectedSources.includes(p.sourceShopId)) &&
    (!query || p.payload.activity_name.toLocaleLowerCase('es').includes(query))
  );
  const jobs = [];
  const storeSummaries = [];
  const warnings = [];
  const groupingEnabled = selection.groupSameTypeAndValidity === true;
  const groupingIdMap = new Map();
  const groupingReservedIds = new Set(dataset.promotions.map(promotion => String(promotion.payload.activity_id)));
  const groupingGroups = new Map();
  const deliveredSourceIds = new Set();
  const splitActivityNotices = new Set();
  for (const store of destinations) {
    const acceptsSource = p => store.sourceShopIds.includes('*') || store.sourceShopIds.includes(p.sourceShopId);
    const availableForStore = dataset.promotions.filter(acceptsSource);
    checkKnown(store.includeActivityIds, new Set(availableForStore.map(p => p.payload.activity_id)), `${store.id}: ActivityID configurados`);
    checkKnown(store.excludeActivityIds, new Set(availableForStore.map(p => p.payload.activity_id)), `${store.id}: ActivityID excluidos en configuración`);
    const selected = sharedSelection.filter(p =>
      acceptsSource(p) &&
      (!store.types || store.types.includes(p.payload.activity_type)) &&
      (!store.includeActivityIds.length || store.includeActivityIds.includes(p.payload.activity_id)) &&
      !store.excludeActivityIds.includes(p.payload.activity_id)
    );
    if (!selected.length) {
      warnings.push({ code: 'EMPTY_STORE', message: `La tienda ${store.id} no tiene promociones después de aplicar los filtros.` });
      continue;
    }
    const ids = new Set();
    for (const p of selected) {
      if (ids.has(p.payload.activity_id)) {
        throw new Error(`La tienda ${store.id} recibiría el mismo ActivityID ${p.payload.activity_id} de varios orígenes. Selecciona un origen con --source-shops o ajusta sourceShopIds.`);
      }
      ids.add(p.payload.activity_id);
      deliveredSourceIds.add(String(p.payload.activity_id));
    }
    const withActions = selected.map(promotion => {
      const copy = structuredClone(promotion);
      copy.payload.action = actionOverrides.get(String(copy.payload.activity_id)) ?? activityAction;
      return copy;
    });
    const createPromotions = withActions.filter(promotion => promotion.payload.action === 1);
    const stopPromotions = withActions.filter(promotion => promotion.payload.action === 2);
    const groupedCreates = groupingEnabled
      ? groupPromotionsByTypeAndValidity(createPromotions, {
          reservedIds: groupingReservedIds,
          idMap: groupingIdMap,
          randomIdFactory: selection.groupRandomIdFactory,
        })
      : { promotions: createPromotions, groups: [] };
    const grouped = groupingEnabled
      ? { promotions: [...groupedCreates.promotions, ...stopPromotions], groups: groupedCreates.groups }
      : { promotions: withActions, groups: [] };
    for (const group of groupedCreates.groups) {
      groupingGroups.set(group.sourceActivityIds.join('|'), group);
    }
    const effectiveStore = {
      ...store,
      appItemIdType: itemIdType(selection.appItemIdType ?? store.appItemIdType),
    };
    const batches = splitActionBatches(grouped.promotions, size, maxItems);
    const activityParts = new Map();
    for (const batch of batches) {
      for (const promotion of batch) {
        if (promotion.payload.action === 2) continue;
        const key = `${promotion.sourceShopId}\0${promotion.payload.activity_id}`;
        activityParts.set(key, (activityParts.get(key) ?? 0) + 1);
      }
    }
    for (const promotion of grouped.promotions) {
      if (promotion.payload.action === 2) continue;
      const key = `${promotion.sourceShopId}\0${promotion.payload.activity_id}`;
      const parts = activityParts.get(key) ?? 1;
      if (parts > 1 && !splitActivityNotices.has(key)) {
        splitActivityNotices.add(key);
        warnings.push({
          code: 'ACTIVITY_SPLIT_ACROSS_REQUESTS',
          message: `ActivityID ${promotion.payload.activity_id}: ${promotion.payload.item_activity_list.length} items distribuidos en ${parts} requests; se conserva el mismo ActivityID.`,
        });
      }
    }
    for (const [index, batch] of batches.entries()) {
      jobs.push({
        store: effectiveStore,
        batchNumber: index + 1,
        sourceShopIds: [...new Set(batch.map(p => p.sourceShopId))],
        payload: {
          auth_token: '{{auth_token}}',
          app_item_id_type: effectiveStore.appItemIdType,
          promo_list: batch.map(p => p.payload.action === 2
            ? { action: 2, activity_id: String(p.payload.activity_id) }
            : generatedPromotionPayload(p.payload)),
        },
      });
    }
    storeSummaries.push({
      id: store.id,
      name: store.name,
      sourceShopIds: [...new Set(selected.map(p => p.sourceShopId))],
      promotions: grouped.promotions.length,
      promotionsBeforeGrouping: selected.length,
      items: grouped.promotions.reduce((n, p) => n + (p.payload.action === 2 ? 0 : p.payload.item_activity_list.length), 0),
      createPromotions: grouped.promotions.filter(p => p.payload.action === 1).length,
      stopPromotions: grouped.promotions.filter(p => p.payload.action === 2).length,
      batches: batches.length,
    });
  }
  if (!jobs.length) throw new Error('Ninguna promoción coincide con la selección de tipos, IDs, orígenes y tiendas.');
  const filteredRequested = selectedIds.filter(id => !deliveredSourceIds.has(id));
  if (filteredRequested.length) warnings.push({ code: 'REQUESTED_IDS_FILTERED', message: `Estos ActivityID solicitados quedaron fuera por los filtros o la configuración de tiendas: ${filteredRequested.join(', ')}.` });
  const effectiveActions = new Set(sharedSelection.map(promotion => actionOverrides.get(String(promotion.payload.activity_id)) ?? activityAction));
  const actionSummary = effectiveActions.size === 1 ? [...effectiveActions][0] : 'mixed';
  return { jobs, stores: storeSummaries, warnings, selection: { activityAction: actionSummary, activityActions: [...actionOverrides].map(([activityId, action]) => ({ activityId, action })), types: selectedTypes, ids: selectedIds, excludeIds: excludedIds, sourceShopIds: selectedSources, storeIds: destinations.map(s => s.id), search: selection.search ?? '', batchSize: size, maxItemsPerBatch: maxItems, grouping: { enabled: groupingEnabled, groups: [...groupingGroups.values()] } }, totals: { stores: storeSummaries.length, requests: jobs.length, promotions: storeSummaries.reduce((n, s) => n + s.promotions, 0), promotionsBeforeGrouping: storeSummaries.reduce((n, s) => n + s.promotionsBeforeGrouping, 0), items: storeSummaries.reduce((n, s) => n + s.items, 0), actions: { create: storeSummaries.reduce((n, s) => n + s.createPromotions, 0), stop: storeSummaries.reduce((n, s) => n + s.stopPromotions, 0) } } };
}
