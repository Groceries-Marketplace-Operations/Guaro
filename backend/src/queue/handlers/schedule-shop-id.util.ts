export interface ScheduleShopIdentifier {
  appShopId: string;
}

/**
 * Resolve raw shop_ids when DiDi returns a mapping, while preserving values
 * that may already be valid app_shop_ids. Both identifiers can be 19-digit
 * values beginning with "57", so their shape alone is not enough to safely
 * discard an input.
 */
export function resolveScheduleShopIdentifiers<T extends ScheduleShopIdentifier>(
  shops: T[],
  shopIdMap: ReadonlyMap<string, string>,
): { mapped: number; preserved: string[] } {
  let mapped = 0;
  const preserved: string[] = [];

  for (const shop of shops) {
    const submittedId = shop.appShopId;
    const resolved = shopIdMap.get(submittedId);
    if (resolved) {
      shop.appShopId = resolved;
      mapped++;
    } else {
      preserved.push(submittedId);
    }
  }

  return { mapped, preserved };
}
