type JsonObject = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
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

  const referencedModifierGroupIds = new Set(items.flatMap(item => [...collectReferencedModifierGroupIds(item)]));
  const modifierGroups = (Array.isArray(menu.modifier_groups) ? menu.modifier_groups : []).filter(value => {
    if (!value || typeof value !== 'object') return false;
    const group = value as JsonObject;
    return [group.app_modifier_group_id, group.app_external_id].some(id => referencedModifierGroupIds.has(text(id)));
  });

  return {
    items,
    modifierGroups,
    foundUpcs: [...foundUpcs],
    missingUpcs,
  };
}
