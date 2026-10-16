import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  validateShopSyncMappings,
  withAtomicShopMappingSync,
} from '../src/shops/shop-sync.util';

interface StoredShop {
  id: string;
  shopId: string;
  appShopId: string;
  brandId: string;
  relationId: string;
}

function shopStore(initial: StoredShop[]) {
  let rows = initial.map(shop => ({ ...shop }));
  let transactionCalls = 0;
  const operations: string[] = [];

  const assertUnique = (candidate: StoredShop) => {
    const collision = rows.find(shop =>
      shop.id !== candidate.id
      && shop.brandId === candidate.brandId
      && shop.appShopId === candidate.appShopId,
    );
    if (collision) throw new Error('Unique constraint failed on brand_id, app_shop_id');
  };

  const transactionClient = {
    $executeRaw: async () => 1,
    shop: {
      findMany: async () => rows.map(({ id, shopId, appShopId, brandId }) => ({
        id, shopId, appShopId, brandId,
      })),
      update: async ({ where, data }: any) => {
        const index = rows.findIndex(shop => shop.id === where.id);
        if (index < 0) throw new Error(`Missing shop ${where.id}`);
        const next = { ...rows[index], ...data };
        assertUnique(next);
        rows[index] = next;
        operations.push(`reserve:${next.shopId}:${next.appShopId}`);
        return next;
      },
      upsert: async ({ where, create, update }: any) => {
        const index = rows.findIndex(shop => shop.shopId === where.shopId);
        if (index < 0) {
          const next = { id: `new-${where.shopId}`, relationId: 'new-relation', ...create } as StoredShop;
          assertUnique(next);
          rows.push(next);
          operations.push(`create:${next.shopId}:${next.appShopId}`);
          return next;
        }
        const next = { ...rows[index], ...update };
        assertUnique(next);
        rows[index] = next;
        operations.push(`persist:${next.shopId}:${next.appShopId}`);
        return next;
      },
    },
  };

  const prisma = {
    $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      transactionCalls++;
      const snapshot = rows.map(shop => ({ ...shop }));
      try {
        return await callback(transactionClient);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    },
  };

  return {
    prisma: prisma as never,
    rows: () => rows.map(shop => ({ ...shop })),
    operations,
    transactionCalls: () => transactionCalls,
  };
}

test('shop synchronization applies a three-way app_shop_id cycle atomically without replacing rows', async () => {
  const store = shopStore([
    { id: 'uuid-a', shopId: 'shop-a', appShopId: 'app-1', brandId: 'brand', relationId: 'relation-a' },
    { id: 'uuid-b', shopId: 'shop-b', appShopId: 'app-2', brandId: 'brand', relationId: 'relation-b' },
    { id: 'uuid-c', shopId: 'shop-c', appShopId: 'app-3', brandId: 'brand', relationId: 'relation-c' },
  ]);

  await withAtomicShopMappingSync(store.prisma, 'brand', [
    { shopId: 'shop-a', appShopId: 'app-2' },
    { shopId: 'shop-b', appShopId: 'app-3' },
    { shopId: 'shop-c', appShopId: 'app-1' },
  ], async ({ tx, shops }) => {
    for (const shop of shops) {
      await tx.shop.upsert({
        where: { shopId: shop.shopId },
        create: { ...shop, brandId: 'brand' },
        update: { appShopId: shop.appShopId, brandId: 'brand' },
      });
    }
  });

  assert.deepEqual(
    store.rows().map(({ id, shopId, appShopId, relationId }) => ({ id, shopId, appShopId, relationId })),
    [
      { id: 'uuid-a', shopId: 'shop-a', appShopId: 'app-2', relationId: 'relation-a' },
      { id: 'uuid-b', shopId: 'shop-b', appShopId: 'app-3', relationId: 'relation-b' },
      { id: 'uuid-c', shopId: 'shop-c', appShopId: 'app-1', relationId: 'relation-c' },
    ],
  );
  assert.equal(store.transactionCalls(), 1);
  assert.equal(store.operations.slice(0, 3).every(operation => operation.includes('__shop_sync_')), true);
});

test('shop synchronization applies a cycle larger than the former 100-row chunks in one transaction', async () => {
  const shopCount = 125;
  const initial = Array.from({ length: shopCount }, (_, index) => ({
    id: `uuid-${index}`,
    shopId: `shop-${index}`,
    appShopId: `app-${index}`,
    brandId: 'brand',
    relationId: `relation-${index}`,
  }));
  const store = shopStore(initial);
  const incoming = initial.map((shop, index) => ({
    shopId: shop.shopId,
    appShopId: `app-${(index + 1) % shopCount}`,
  }));

  await withAtomicShopMappingSync(store.prisma, 'brand', incoming, async ({ tx, shops }) => {
    for (const shop of shops) {
      await tx.shop.upsert({
        where: { shopId: shop.shopId },
        create: { ...shop, brandId: 'brand' },
        update: { appShopId: shop.appShopId, brandId: 'brand' },
      });
    }
  });

  const persisted = store.rows();
  assert.equal(store.transactionCalls(), 1);
  assert.equal(persisted.length, shopCount);
  assert.deepEqual(
    persisted.map(({ id, relationId }) => ({ id, relationId })),
    initial.map(({ id, relationId }) => ({ id, relationId })),
  );
  assert.deepEqual(
    persisted.map(shop => shop.appShopId),
    incoming.map(shop => shop.appShopId),
  );
});

test('shop synchronization releases a mapping chain that ends in a newly created shop', async () => {
  const store = shopStore([
    { id: 'uuid-a', shopId: 'shop-a', appShopId: 'app-1', brandId: 'brand', relationId: 'relation-a' },
    { id: 'uuid-b', shopId: 'shop-b', appShopId: 'app-2', brandId: 'brand', relationId: 'relation-b' },
    { id: 'uuid-c', shopId: 'shop-c', appShopId: 'app-3', brandId: 'brand', relationId: 'relation-c' },
  ]);
  const incoming = [
    { shopId: 'shop-a', appShopId: 'app-2' },
    { shopId: 'shop-b', appShopId: 'app-3' },
    { shopId: 'shop-c', appShopId: 'app-4' },
    { shopId: 'shop-d', appShopId: 'app-1' },
  ];

  await withAtomicShopMappingSync(store.prisma, 'brand', incoming, async ({ tx, shops }) => {
    for (const shop of shops) {
      await tx.shop.upsert({
        where: { shopId: shop.shopId },
        create: { ...shop, brandId: 'brand' },
        update: { appShopId: shop.appShopId, brandId: 'brand' },
      });
    }
  });

  assert.deepEqual(
    store.rows().map(({ shopId, appShopId }) => ({ shopId, appShopId })),
    incoming,
  );
  assert.deepEqual(
    store.rows().slice(0, 3).map(({ id, relationId }) => ({ id, relationId })),
    [
      { id: 'uuid-a', relationId: 'relation-a' },
      { id: 'uuid-b', relationId: 'relation-b' },
      { id: 'uuid-c', relationId: 'relation-c' },
    ],
  );
});

test('shop synchronization rejects duplicate incoming identifiers before starting a transaction', async () => {
  const store = shopStore([]);

  await assert.rejects(
    withAtomicShopMappingSync(store.prisma, 'brand', [
      { shopId: 'shop-a', appShopId: 'same-app-id' },
      { shopId: 'shop-b', appShopId: 'same-app-id' },
    ], async () => undefined),
    /Duplicate app_shop_id.*same-app-id/,
  );
  assert.equal(store.transactionCalls(), 0);

  assert.throws(
    () => validateShopSyncMappings([
      { shopId: 'same-shop-id', appShopId: 'app-a' },
      { shopId: 'same-shop-id', appShopId: 'app-b' },
    ]),
    /Duplicate shop_id.*same-shop-id/,
  );
});

test('shop synchronization deduplicates an identical mapping repeated by mutable pagination', () => {
  assert.deepEqual(
    validateShopSyncMappings([
      { shopId: 'shop-a', appShopId: 'app-a' },
      { shopId: ' shop-a ', appShopId: ' app-a ' },
    ]),
    [{ shopId: 'shop-a', appShopId: 'app-a' }],
  );
});

test('shop synchronization rolls reservations back when persistence fails', async () => {
  const initial = [
    { id: 'uuid-a', shopId: 'shop-a', appShopId: 'app-1', brandId: 'brand', relationId: 'relation-a' },
    { id: 'uuid-b', shopId: 'shop-b', appShopId: 'app-2', brandId: 'brand', relationId: 'relation-b' },
  ];
  const store = shopStore(initial);

  await assert.rejects(
    withAtomicShopMappingSync(store.prisma, 'brand', [
      { shopId: 'shop-a', appShopId: 'app-2' },
      { shopId: 'shop-b', appShopId: 'app-1' },
    ], async () => {
      throw new Error('simulated persistence failure');
    }),
    /simulated persistence failure/,
  );
  assert.deepEqual(store.rows(), initial);
});
