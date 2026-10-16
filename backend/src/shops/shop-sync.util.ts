import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ShopSyncMapping {
  shopId: string;
  appShopId: string;
}

export interface ExistingShopSyncMapping extends ShopSyncMapping {
  id: string;
  brandId: string;
}

interface ShopSyncTransactionContext<T extends ShopSyncMapping> {
  tx: Prisma.TransactionClient;
  shops: T[];
  existingByShopId: ReadonlyMap<string, ExistingShopSyncMapping>;
}

/**
 * Trims identifiers and rejects ambiguous mappings before any database write.
 * Both identifiers must be one-to-one inside a synchronization payload.
 */
export function validateShopSyncMappings<T extends ShopSyncMapping>(shops: readonly T[]): T[] {
  const normalized: T[] = [];
  const appShopIdByShopId = new Map<string, string>();
  const shopIdByAppShopId = new Map<string, string>();

  for (const shop of shops) {
    const shopId = shop.shopId?.trim();
    const appShopId = shop.appShopId?.trim();
    if (!shopId || !appShopId) {
      throw new Error('Every shop synchronization mapping requires shop_id and app_shop_id');
    }
    const previousAppShopId = appShopIdByShopId.get(shopId);
    if (previousAppShopId === appShopId) continue;
    if (previousAppShopId !== undefined) {
      throw new Error(`Duplicate shop_id in shop synchronization payload: ${shopId}`);
    }
    const previousShopId = shopIdByAppShopId.get(appShopId);
    if (previousShopId !== undefined) {
      throw new Error(`Duplicate app_shop_id in shop synchronization payload: ${appShopId}`);
    }

    appShopIdByShopId.set(shopId, appShopId);
    shopIdByAppShopId.set(appShopId, shopId);
    normalized.push({ ...shop, shopId, appShopId });
  }

  return normalized;
}

/**
 * Applies a brand's shop mapping in one transaction while preserving Shop rows.
 *
 * Existing target rows whose mapping changes first receive transaction-local,
 * unique app_shop_id values. This releases every final identifier before the
 * caller performs its upserts, so swaps and longer cycles cannot trip the
 * (brand_id, app_shop_id) unique constraint. A failed callback rolls the whole
 * reservation and update sequence back.
 */
export async function withAtomicShopMappingSync<T extends ShopSyncMapping, TResult>(
  prisma: PrismaService,
  brandId: string,
  incomingShops: readonly T[],
  persist: (context: ShopSyncTransactionContext<T>) => Promise<TResult>,
): Promise<TResult> {
  const shops = validateShopSyncMappings(incomingShops);

  return prisma.$transaction(async tx => {
    // PostgreSQL returns pseudo-type void for this function. Use $executeRaw
    // because Prisma cannot deserialize that value through $queryRaw.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`guaro:shop-sync:${brandId}`}, 0)
      )
    `;

    if (shops.length === 0) {
      return persist({ tx, shops, existingByShopId: new Map() });
    }

    const shopIds = shops.map(shop => shop.shopId);
    const appShopIds = shops.map(shop => shop.appShopId);
    const targetShopIds = new Set(shopIds);
    const targetAppShopIds = new Set(appShopIds);
    const desiredByShopId = new Map(shops.map(shop => [shop.shopId, shop.appShopId]));
    const candidates = await tx.shop.findMany({
      where: {
        OR: [
          { shopId: { in: shopIds } },
          { brandId, appShopId: { in: appShopIds } },
        ],
      },
      select: { id: true, shopId: true, appShopId: true, brandId: true },
    });
    const existingByShopId = new Map(
      candidates
        .filter(shop => targetShopIds.has(shop.shopId))
        .map(shop => [shop.shopId, shop]),
    );

    const blockers = candidates.filter(shop =>
      shop.brandId === brandId
      && targetAppShopIds.has(shop.appShopId)
      && !targetShopIds.has(shop.shopId),
    );
    if (blockers.length > 0) {
      const details = blockers
        .map(shop => `${shop.appShopId} is still assigned to shop_id ${shop.shopId}`)
        .join('; ');
      throw new Error(`Cannot synchronize shop mappings because ${details}`);
    }

    const reservationId = randomUUID();
    let reservationIndex = 0;
    const existingInLockOrder = [...existingByShopId.values()]
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const existing of existingInLockOrder) {
      const desiredAppShopId = desiredByShopId.get(existing.shopId)!;
      if (existing.brandId === brandId && existing.appShopId === desiredAppShopId) continue;

      await tx.shop.update({
        where: { id: existing.id },
        data: {
          appShopId: `__shop_sync_${reservationId}_${reservationIndex++}`,
        },
      });
    }

    return persist({ tx, shops, existingByShopId });
  }, { maxWait: 10_000, timeout: 120_000 });
}
