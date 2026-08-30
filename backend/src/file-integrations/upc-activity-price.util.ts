type JsonObject = Record<string, unknown>;

export type ActivityPriceVerification = {
  confirmedIds: string[];
  pendingUpdates: JsonObject[];
  missingIds: string[];
};

export type ActivityPriceMenuUpload = {
  menus: JsonObject[];
  categories: JsonObject[];
  items: JsonObject[];
  categoryIds: string[];
};

export function shouldRetryActivityPriceUpload(input: {
  taskStatus: number;
  confirmedCount: number;
  expectedCount: number;
  pendingUpdateCount: number;
  attempt: number;
  maxAttempts: number;
}) {
  if (![1, 2, 5].includes(input.taskStatus)) return false;
  if (input.confirmedCount >= input.expectedCount) return false;
  return input.pendingUpdateCount > 0 && input.attempt < input.maxAttempts;
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function validPrice(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function numericValue(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildActivityPriceUpdate(item: JsonObject, upc: string, price: number): JsonObject {
  return {
    app_item_id: text(item.app_item_id),
    upc,
    item_name: text(item.item_name),
    short_desc: text(item.short_desc) || text(item.item_name),
    price,
    activity_price: price,
    status: Number.isFinite(Number(item.status)) ? Number(item.status) : 1,
  };
}

export function prepareActivityPriceUpdates(menu: JsonObject, targetUpc: string) {
  const normalizedUpc = text(targetUpc);
  const items = Array.isArray(menu.items)
    ? menu.items.filter(value => value && typeof value === 'object') as JsonObject[]
    : [];
  const matches = items.filter(item => text(item.upc) === normalizedUpc && text(item.app_item_id));
  const alreadyCurrent: JsonObject[] = [];
  const updates: JsonObject[] = [];

  for (const item of matches) {
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0) continue;
    if (Number(item.activity_price) === price) {
      alreadyCurrent.push(item);
      continue;
    }
    updates.push(buildActivityPriceUpdate(item, normalizedUpc, price));
  }

  return { matches, alreadyCurrent, updates };
}

export function buildActivityPriceMenuUpload(
  menu: JsonObject,
  targetUpc: string,
  expectedAppItemIds?: readonly string[],
) {
  const prepared = prepareActivityPriceUpdates(menu, targetUpc);
  const expected = expectedAppItemIds
    ? new Set(expectedAppItemIds.map(text).filter(Boolean))
    : null;
  const updates = expected
    ? prepared.updates.filter(item => expected.has(text(item.app_item_id)))
    : prepared.updates;
  const updateById = new Map(updates.map(item => [text(item.app_item_id), item]));
  const sourceItems = Array.isArray(menu.items)
    ? menu.items.filter(value => value && typeof value === 'object') as JsonObject[]
    : [];
  const menus = Array.isArray(menu.menus)
    ? menu.menus.filter(value => value && typeof value === 'object') as JsonObject[]
    : [];
  const categories = Array.isArray(menu.categories)
    ? menu.categories.filter(value => value && typeof value === 'object') as JsonObject[]
    : [];
  if (!menus.length || !categories.length || !sourceItems.length) {
    throw new Error('Exported menu must contain menus, categories, and items before uploadGrocery can be used');
  }

  const items = sourceItems.map(item => {
    const update = updateById.get(text(item.app_item_id));
    return update ? { ...item, activity_price: update.activity_price } : item;
  });
  const categoryIds = categories.map(category => text(category.app_category_id)).filter(Boolean);
  return {
    ...prepared,
    updates,
    upload: { menus, categories, items, categoryIds } satisfies ActivityPriceMenuUpload,
  };
}

export function verifyActivityPriceUpdates(
  menu: JsonObject,
  targetUpc: string,
  expectedAppItemIds: readonly string[],
): ActivityPriceVerification {
  const normalizedUpc = text(targetUpc);
  const expectedIds = [...new Set(expectedAppItemIds.map(text).filter(Boolean))];
  const items = Array.isArray(menu.items)
    ? menu.items.filter(value => value && typeof value === 'object') as JsonObject[]
    : [];
  const itemsById = new Map<string, JsonObject>();

  for (const item of items) {
    const appItemId = text(item.app_item_id);
    if (appItemId && !itemsById.has(appItemId)) itemsById.set(appItemId, item);
  }

  const confirmedIds: string[] = [];
  const pendingUpdates: JsonObject[] = [];
  const missingIds: string[] = [];

  for (const appItemId of expectedIds) {
    const item = itemsById.get(appItemId);
    const price = item ? validPrice(item.price) : null;
    if (!item || text(item.upc) !== normalizedUpc || price === null) {
      missingIds.push(appItemId);
      continue;
    }

    const activityPrice = numericValue(item.activity_price);
    if (activityPrice !== null && activityPrice === price) {
      confirmedIds.push(appItemId);
      continue;
    }

    pendingUpdates.push(buildActivityPriceUpdate(item, normalizedUpc, price));
  }

  return { confirmedIds, pendingUpdates, missingIds };
}
