type JsonObject = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
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
    updates.push({
      app_item_id: text(item.app_item_id),
      upc: normalizedUpc,
      item_name: text(item.item_name),
      short_desc: text(item.short_desc) || text(item.item_name),
      price,
      activity_price: price,
      status: Number.isFinite(Number(item.status)) ? Number(item.status) : 1,
    });
  }

  return { matches, alreadyCurrent, updates };
}
