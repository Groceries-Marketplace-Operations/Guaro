type JsonObject = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function selectMenuUpcs(menu: JsonObject, requestedUpcs: string[]) {
  const requested = new Set(requestedUpcs.map(text).filter(Boolean));
  const sourceItems = Array.isArray(menu.items) ? menu.items.filter(item => item && typeof item === 'object') as JsonObject[] : [];
  const items = sourceItems.filter(item => requested.has(text(item.upc)));
  const foundUpcs = new Set(items.map(item => text(item.upc)).filter(Boolean));
  const missingUpcs = [...requested].filter(upc => !foundUpcs.has(upc));

  return {
    items,
    foundUpcs: [...foundUpcs],
    missingUpcs,
  };
}
