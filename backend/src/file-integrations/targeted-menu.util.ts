type JsonObject = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function collectReferencedModifierGroupIds(item: JsonObject) {
  const ids = new Set<string>();
  const visit = (value: unknown, key = ''): void => {
    const normalizedKey = key.toLowerCase();
    const modifierReference = normalizedKey.includes('modifier') || /(^|_)mg(_|$)/.test(normalizedKey);
    if (modifierReference && (typeof value === 'string' || typeof value === 'number')) {
      const id = text(value);
      if (id) ids.add(id);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(entry => visit(entry, key));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value as JsonObject).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  Object.entries(item).forEach(([key, value]) => visit(value, key));
  return ids;
}

export function selectMenuUpcs(menu: JsonObject, requestedUpcs: string[]) {
  const requested = new Set(requestedUpcs.map(text).filter(Boolean));
  const sourceItems = Array.isArray(menu.items) ? menu.items.filter(item => item && typeof item === 'object') as JsonObject[] : [];
  const items = sourceItems.filter(item => requested.has(text(item.upc)));
  const foundUpcs = new Set(items.map(item => text(item.upc)).filter(Boolean));
  const missingUpcs = [...requested].filter(upc => !foundUpcs.has(upc));
  const itemIds = new Set(items.map(item => text(item.app_item_id)).filter(Boolean));

  const sourceCategories = Array.isArray(menu.categories)
    ? menu.categories.filter(category => category && typeof category === 'object') as JsonObject[]
    : [];
  const categoryById = new Map(sourceCategories.map(category => [text(category.app_category_id), category]));
  const includedCategoryIds = new Set<string>();

  for (const category of sourceCategories) {
    if (stringArray(category.app_item_ids).some(id => itemIds.has(id))) {
      includedCategoryIds.add(text(category.app_category_id));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of sourceCategories) {
      const id = text(category.app_category_id);
      if (!id || includedCategoryIds.has(id)) continue;
      if (stringArray(category.sub_category_ids).some(child => includedCategoryIds.has(child))) {
        includedCategoryIds.add(id);
        changed = true;
      }
    }
  }

  const categories = [...includedCategoryIds].flatMap(id => {
    const category = categoryById.get(id);
    if (!category) return [];
    const appItemIds = stringArray(category.app_item_ids).filter(itemId => itemIds.has(itemId));
    const subCategoryIds = stringArray(category.sub_category_ids).filter(categoryId => includedCategoryIds.has(categoryId));
    return [{
      ...category,
      ...(Array.isArray(category.app_item_ids) ? { app_item_ids: appItemIds } : {}),
      ...(Array.isArray(category.sub_category_ids) ? { sub_category_ids: subCategoryIds } : {}),
    }];
  });

  const menus = (Array.isArray(menu.menus) ? menu.menus : []).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const source = value as JsonObject;
    return [{ ...source, app_category_ids: stringArray(source.app_category_ids).filter(id => includedCategoryIds.has(id)) }];
  }).filter(value => (value.app_category_ids as string[]).length > 0);

  const referencedModifierGroupIds = new Set(items.flatMap(item => [...collectReferencedModifierGroupIds(item)]));
  const modifierGroups = (Array.isArray(menu.modifier_groups) ? menu.modifier_groups : []).filter(value => {
    if (!value || typeof value !== 'object') return false;
    const group = value as JsonObject;
    return [group.app_modifier_group_id, group.app_external_id].some(id => referencedModifierGroupIds.has(text(id)));
  });

  return {
    menus,
    categories,
    items,
    modifierGroups,
    foundUpcs: [...foundUpcs],
    missingUpcs,
  };
}

export function selectMenuUpcBatches(menu: JsonObject, requestedUpcs: string[], batchSize = 3000) {
  const batches: ReturnType<typeof selectMenuUpcs>[] = [];
  for (let offset = 0; offset < requestedUpcs.length; offset += batchSize) {
    batches.push(selectMenuUpcs(menu, requestedUpcs.slice(offset, offset + batchSize)));
  }
  return batches;
}
