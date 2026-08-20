import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AutoOpenSelectionService,
  LIVE_AUTO_OPEN_EMERGENCY_STATUSES,
  autoOpenPoolBrandSummaryKey,
  buildAutoOpenStoreWhere,
  emptyAutoOpenStoreSummary,
} from '../src/integrations/auto-open-selection.service';
import {
  AutoOpenStoreInclusionFilter,
  ListAutoOpenStoresDto,
} from '../src/integrations/dto/list-auto-open-stores.dto';
import { AutoOpenPoolsService } from '../src/integrations/auto-open-pools.service';

const POOL_ID = '10000000-0000-4000-8000-000000000001';
const BRAND_ID = '20000000-0000-4000-8000-000000000001';
const FIXED_TIME = new Date('2026-08-20T07:00:00.000Z');

function membership(
  brandId: string,
  totalStores: number,
  application: { deletedAt: Date | null } | null = { deletedAt: null },
) {
  return {
    poolId: POOL_ID,
    brandId,
    brand: { application, _count: { shops: totalStores } },
  };
}

test('pool summaries are disjoint, ignore deleted records, and give missing application precedence', async () => {
  const captured: Record<string, any> = {};
  const prisma = {
    autoOpenPoolBrand: {
      findMany: async (args: any) => {
        captured.memberships = args;
        return [
          membership('brand-configuration', 2, null),
          membership('brand-all-emergency', 3),
          membership('brand-targeted', 4),
          membership('brand-included', 1),
        ];
      },
    },
    storeEmergency: {
      findMany: async (args: any) => {
        captured.allBrand = args;
        return [{ brandId: 'brand-all-emergency' }];
      },
    },
    storeEmergencyTarget: {
      findMany: async (args: any) => {
        captured.targets = args;
        return [
          {
            shopId: 'target-shop-1',
            emergency: { brandId: 'brand-targeted' },
            shop: { brandId: 'brand-targeted' },
          },
          // A duplicate target is counted once.
          {
            shopId: 'target-shop-1',
            emergency: { brandId: 'brand-targeted' },
            shop: { brandId: 'brand-targeted' },
          },
          // Corrupt cross-brand data must never affect the summary or detail filter.
          {
            shopId: 'cross-brand-shop',
            emergency: { brandId: 'brand-targeted' },
            shop: { brandId: 'brand-included' },
          },
        ];
      },
    },
  };
  const service = new AutoOpenSelectionService(prisma as never);
  const result = await service.summarizePools([POOL_ID], FIXED_TIME);
  const summary = result.byPool.get(POOL_ID)!;

  assert.deepEqual(summary, {
    totalStores: 10,
    includedStores: 4,
    emergencyProtectedStores: 4,
    configurationBlockedStores: 2,
    calculatedAt: FIXED_TIME.toISOString(),
  });
  assert.equal(
    summary.totalStores,
    summary.includedStores + summary.emergencyProtectedStores + summary.configurationBlockedStores,
  );
  assert.deepEqual(
    result.byPoolBrand.get(autoOpenPoolBrandSummaryKey(POOL_ID, 'brand-configuration')),
    {
      totalStores: 2,
      includedStores: 0,
      emergencyProtectedStores: 0,
      configurationBlockedStores: 2,
      calculatedAt: FIXED_TIME.toISOString(),
    },
  );
  assert.equal(result.targetedProtectedShopIds.has('target-shop-1'), true);
  assert.equal(result.targetedProtectedShopIds.has('cross-brand-shop'), false);
  assert.equal(captured.memberships.where.brand.deletedAt, null);
  assert.equal(captured.memberships.select.brand.select._count.select.shops.where.deletedAt, null);
  assert.deepEqual(captured.allBrand.where.status.in, [...LIVE_AUTO_OPEN_EMERGENCY_STATUSES]);
  assert.equal(captured.allBrand.where.finishedAt, null);
  assert.deepEqual(captured.targets.where.emergency.status.in, [...LIVE_AUTO_OPEN_EMERGENCY_STATUSES]);
  assert.equal(LIVE_AUTO_OPEN_EMERGENCY_STATUSES.includes('partial_restored' as never), false);
  assert.equal(LIVE_AUTO_OPEN_EMERGENCY_STATUSES.includes('restore_failed' as never), false);
});

test('store detail is paginated, searchable, classified with stable precedence, and makes no remote calls', async t => {
  const originalFetch = global.fetch;
  let remoteCalls = 0;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (async () => {
    remoteCalls++;
    throw new Error('Auto Open inventory must not call a remote API');
  }) as typeof fetch;
  const captured: Record<string, any> = {};
  const app = { id: 'application', deletedAt: null };
  const noEmergency: never[] = [];
  const shops = [
    {
      id: 'shop-configuration', shopId: 'shop-id-configuration', appShopId: 'app-configuration',
      name: 'Configuration shop', city: 'Mexico City', status: 'lead',
      brand: {
        id: 'brand-configuration', brandId: 'external-configuration', brandName: 'Configuration', country: 'MX',
        application: null,
        storeEmergencies: [{ id: 'ignored-emergency', brandId: 'brand-configuration', mode: 'all_brand', status: 'offline' }],
      },
      emergencies: noEmergency,
    },
    {
      id: 'shop-brand-emergency', shopId: 'shop-id-brand', appShopId: 'app-brand',
      name: 'Brand emergency shop', city: 'Bogota', status: 'integrated',
      brand: {
        id: 'brand-all', brandId: 'external-all', brandName: 'All emergency', country: 'CO',
        application: app,
        storeEmergencies: [{ id: 'emergency-brand', brandId: 'brand-all', mode: 'all_brand', status: 'offline' }],
      },
      emergencies: noEmergency,
    },
    {
      id: 'shop-targeted', shopId: 'shop-id-targeted', appShopId: 'app-targeted',
      name: 'Targeted shop', city: 'San Jose', status: 'online',
      brand: {
        id: 'brand-targeted', brandId: 'external-targeted', brandName: 'Targeted emergency', country: 'CR',
        application: app, storeEmergencies: noEmergency,
      },
      emergencies: [{ emergency: { id: 'emergency-store', brandId: 'brand-targeted', mode: 'shop_list', status: 'restoring' } }],
    },
    {
      id: 'shop-included', shopId: 'shop-id-included', appShopId: 'app-included',
      name: 'Included shop', city: null, status: 'application',
      brand: {
        id: 'brand-included', brandId: 'external-included', brandName: 'Included', country: 'MX',
        application: app, storeEmergencies: noEmergency,
      },
      emergencies: noEmergency,
    },
  ];
  const prisma = {
    autoOpenPoolBrand: {
      findMany: async () => [
        membership('brand-configuration', 1, null),
        membership('brand-all', 1),
        membership('brand-targeted', 1),
        membership('brand-included', 1),
      ],
    },
    storeEmergency: { findMany: async () => [{ brandId: 'brand-all' }] },
    storeEmergencyTarget: {
      findMany: async () => [{
        shopId: 'shop-targeted',
        emergency: { brandId: 'brand-targeted' },
        shop: { brandId: 'brand-targeted' },
      }],
    },
    shop: {
      findMany: async (args: any) => { captured.findMany = args; return shops; },
      count: async (args: any) => { captured.count = args; return 4; },
    },
  };
  const service = new AutoOpenSelectionService(prisma as never);
  const result = await service.listPoolStores(POOL_ID, {
    page: 2,
    limit: 2,
    search: 'Needle',
    inclusion: AutoOpenStoreInclusionFilter.all,
  });

  assert.equal(captured.findMany.skip, 2);
  assert.equal(captured.findMany.take, 2);
  assert.deepEqual(captured.count.where, captured.findMany.where);
  assert.match(JSON.stringify(captured.findMany.where), /Needle/);
  assert.doesNotMatch(JSON.stringify(captured.findMany.where), /"status"/);
  assert.deepEqual(result.data.map(item => [item.id, item.inclusion, item.reason]), [
    ['shop-configuration', 'configuration', 'missing_active_application'],
    ['shop-brand-emergency', 'emergency', 'live_brand_emergency'],
    ['shop-targeted', 'emergency', 'live_store_emergency'],
    ['shop-included', 'included', null],
  ]);
  assert.deepEqual(result.data[1].emergency, {
    id: 'emergency-brand', mode: 'all_brand', status: 'offline', scope: 'brand',
  });
  assert.deepEqual(result.data[2].emergency, {
    id: 'emergency-store', mode: 'shop_list', status: 'restoring', scope: 'store',
  });
  assert.equal('brandId' in result.data[2].emergency!, false);
  assert.equal(result.summaryScope, 'pool');
  assert.equal(result.summary.totalStores, 4);
  assert.equal(result.total, 4);
  assert.equal(result.page, 2);
  assert.equal(result.limit, 2);
  assert.equal(remoteCalls, 0);
});

test('resolved inclusion filters cannot select a corrupt cross-brand emergency target', () => {
  const resolved = {
    activeApplicationBrandIds: new Set(['brand-a']),
    allBrandProtectedBrandIds: new Set<string>(),
    targetedProtectedShopIds: new Set(['matching-shop']),
  };
  const where = buildAutoOpenStoreWhere(POOL_ID, {
    inclusion: AutoOpenStoreInclusionFilter.emergency,
    search: 'Shop 7',
    brandId: BRAND_ID,
  }, resolved);
  const serialized = JSON.stringify(where);
  assert.match(serialized, /matching-shop/);
  assert.doesNotMatch(serialized, /cross-brand-shop/);
  assert.match(serialized, /Shop 7/);
  assert.match(serialized, new RegExp(BRAND_ID));
  assert.match(serialized, new RegExp(POOL_ID));
  assert.doesNotMatch(serialized, /"status"/);
});

test('store list DTO transforms valid pagination and rejects excessive limits and unknown filters', async () => {
  const valid = plainToInstance(ListAutoOpenStoresDto, {
    page: '2',
    limit: '100',
    search: '  tienda  ',
    brandId: BRAND_ID,
    inclusion: 'emergency',
  });
  assert.equal((await validate(valid)).length, 0);
  assert.equal(valid.page, 2);
  assert.equal(valid.limit, 100);
  assert.equal(valid.search, 'tienda');

  const excessive = plainToInstance(ListAutoOpenStoresDto, { limit: '101' });
  assert.ok((await validate(excessive)).some(error => error.property === 'limit'));
  const unknown = plainToInstance(ListAutoOpenStoresDto, { inclusion: 'blocked' });
  assert.ok((await validate(unknown)).some(error => error.property === 'inclusion'));
});

test('store detail reads the persisted pool without reconciling managed pools or performing writes', async () => {
  let ensureCalls = 0;
  let selectionCalls = 0;
  const prisma = {
    autoOpenPool: {
      findUnique: async () => ({ id: POOL_ID, managedKey: 'ka-MX', brands: [] }),
    },
  };
  const selection = {
    listPoolStores: async () => {
      selectionCalls++;
      return { data: [], total: 0 };
    },
  };
  const service = new AutoOpenPoolsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    selection as never,
  );
  service.ensureManagedKaPools = async () => { ensureCalls++; };
  const result = await service.listStores(POOL_ID, plainToInstance(ListAutoOpenStoresDto, {}));
  assert.deepEqual(result, { data: [], total: 0 });
  assert.equal(selectionCalls, 1);
  assert.equal(ensureCalls, 0);
});

test('pool list attaches full-pool and per-brand summaries without embedding shops', async () => {
  const calculatedAt = FIXED_TIME.toISOString();
  const poolSummary = {
    totalStores: 2, includedStores: 1, emergencyProtectedStores: 1,
    configurationBlockedStores: 0, calculatedAt,
  };
  const brandSummary = {
    totalStores: 2, includedStores: 1, emergencyProtectedStores: 1,
    configurationBlockedStores: 0, calculatedAt,
  };
  const prisma = {
    autoOpenPool: {
      findMany: async () => [{
        id: POOL_ID,
        name: 'Pool',
        brands: [{ poolId: POOL_ID, brandId: BRAND_ID, brand: { id: BRAND_ID, brandName: 'Brand' } }],
      }],
    },
  };
  const selection = {
    summarizePools: async () => ({
      byPool: new Map([[POOL_ID, poolSummary]]),
      byPoolBrand: new Map([[autoOpenPoolBrandSummaryKey(POOL_ID, BRAND_ID), brandSummary]]),
      calculatedAt,
    }),
  };
  const service = new AutoOpenPoolsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    selection as never,
  );
  service.ensureManagedKaPools = async () => undefined;
  const result = await service.list();
  assert.deepEqual(result[0].storeSummary, poolSummary);
  assert.deepEqual(result[0].brands[0].storeSummary, brandSummary);
  assert.equal('shops' in result[0].brands[0].brand, false);
  assert.deepEqual(emptyAutoOpenStoreSummary(calculatedAt), {
    totalStores: 0,
    includedStores: 0,
    emergencyProtectedStores: 0,
    configurationBlockedStores: 0,
    calculatedAt,
  });
});
