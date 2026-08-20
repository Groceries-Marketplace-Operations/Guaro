import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Country, KaType } from '@prisma/client';
import { AutoOpenPoolsService } from '../src/integrations/auto-open-pools.service';

const MX_POOL_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOM_POOL_ID = '10000000-0000-4000-8000-000000000009';
const BRAND_A = '20000000-0000-4000-8000-000000000001';
const BRAND_B = '20000000-0000-4000-8000-000000000002';
const BRAND_C = '20000000-0000-4000-8000-000000000003';
const NON_KA_BRAND = '20000000-0000-4000-8000-000000000004';
const CROSS_COUNTRY_BRAND = '20000000-0000-4000-8000-000000000005';
const DELETED_BRAND = '20000000-0000-4000-8000-000000000006';

interface FakeBrand {
  id: string;
  brandId: string;
  brandName: string;
  country: Country;
  kaType: KaType;
  deletedAt: Date | null;
}

interface FakePool {
  id: string;
  managedKey: string | null;
  name: string;
  country: Country;
  active: boolean;
  dryRun: boolean;
  executionHours: number[];
  timezone: string;
  webhookId: string | null;
}

function managedPoolHarness() {
  const brands: FakeBrand[] = [
    { id: BRAND_A, brandId: 'external-a', brandName: 'Brand A', country: Country.MX, kaType: KaType.KA, deletedAt: null },
    { id: BRAND_B, brandId: 'external-b', brandName: 'Brand B', country: Country.MX, kaType: KaType.KA, deletedAt: null },
    { id: NON_KA_BRAND, brandId: 'external-sme', brandName: 'SME', country: Country.MX, kaType: KaType.SME, deletedAt: null },
    { id: CROSS_COUNTRY_BRAND, brandId: 'external-co', brandName: 'Colombia KA', country: Country.CO, kaType: KaType.KA, deletedAt: null },
    { id: DELETED_BRAND, brandId: 'external-deleted', brandName: 'Deleted KA', country: Country.MX, kaType: KaType.KA, deletedAt: new Date() },
  ];
  const pools = new Map<string, FakePool>([
    [MX_POOL_ID, {
      id: MX_POOL_ID,
      managedKey: 'ka-MX',
      name: 'KA Auto Open — Mexico',
      country: Country.MX,
      active: false,
      dryRun: true,
      executionHours: [3, 9, 15, 21],
      timezone: 'America/Mexico_City',
      webhookId: null,
    }],
    [CUSTOM_POOL_ID, {
      id: CUSTOM_POOL_ID,
      managedKey: null,
      name: 'Custom Mexico',
      country: Country.MX,
      active: false,
      dryRun: true,
      executionHours: [9],
      timezone: 'America/Mexico_City',
      webhookId: null,
    }],
  ]);
  const memberships = new Map<string, Set<string>>([
    [MX_POOL_ID, new Set([BRAND_A, BRAND_B])],
    [CUSTOM_POOL_ID, new Set([BRAND_A, BRAND_B])],
  ]);
  const exclusions = new Map<string, Set<string>>([[MX_POOL_ID, new Set()]]);
  const executions: Array<Record<string, any>> = [];
  const operationLog: string[] = [];
  const lockQueries: string[] = [];
  const queueTransactionStates: boolean[] = [];
  let transactionActive = false;
  let executionSequence = 0;
  let serverRemoteWritesEnabled = false;

  const getMembership = (poolId: string) => {
    let value = memberships.get(poolId);
    if (!value) {
      value = new Set();
      memberships.set(poolId, value);
    }
    return value;
  };
  const getExclusions = (poolId: string) => {
    let value = exclusions.get(poolId);
    if (!value) {
      value = new Set();
      exclusions.set(poolId, value);
    }
    return value;
  };
  const materializePool = (pool: FakePool) => ({
    ...pool,
    webhook: null,
    brands: [...getMembership(pool.id)].map(brandId => ({
      poolId: pool.id,
      brandId,
      brand: brands.find(brand => brand.id === brandId),
    })),
    brandExclusions: [...getExclusions(pool.id)].map(brandId => ({ brandId })),
  });
  const deleteFromSet = (values: Set<string>, filter?: { in?: string[]; notIn?: string[] }) => {
    if (!filter) {
      values.clear();
      return;
    }
    if (filter.in) filter.in.forEach(value => values.delete(value));
    if (filter.notIn) {
      const retained = new Set(filter.notIn);
      [...values].filter(value => !retained.has(value)).forEach(value => values.delete(value));
    }
  };
  const cloneMapOfSets = (source: Map<string, Set<string>>) => new Map(
    [...source].map(([key, values]) => [key, new Set(values)]),
  );
  const restoreMapOfSets = (target: Map<string, Set<string>>, snapshot: Map<string, Set<string>>) => {
    target.clear();
    snapshot.forEach((values, key) => target.set(key, new Set(values)));
  };

  const tx = {
    $queryRaw: async (query: any) => {
      operationLog.push('pool.lock');
      lockQueries.push(query.sql ?? String(query));
      return [{ id: MX_POOL_ID }];
    },
    autoOpenPool: {
      findUnique: async ({ where }: any) => {
        operationLog.push('pool.find');
        const pool = pools.get(where.id);
        return pool ? materializePool(pool) : null;
      },
      update: async ({ where, data }: any) => {
        operationLog.push('pool.update');
        const pool = pools.get(where.id);
        if (!pool) throw new Error('Pool not found');
        for (const key of ['name', 'active', 'dryRun', 'executionHours', 'timezone', 'country'] as const) {
          if (data[key] !== undefined) (pool as any)[key] = data[key];
        }
        return materializePool(pool);
      },
      upsert: async ({ where, create }: any) => {
        operationLog.push(`pool.upsert:${where.managedKey}`);
        let pool = [...pools.values()].find(candidate => candidate.managedKey === where.managedKey);
        if (!pool) {
          const suffix = where.managedKey === 'ka-CO' ? '2' : '3';
          pool = {
            id: `10000000-0000-4000-8000-00000000000${suffix}`,
            managedKey: create.managedKey,
            name: create.name,
            country: create.country,
            active: create.active,
            dryRun: create.dryRun,
            executionHours: create.executionHours,
            timezone: create.timezone,
            webhookId: null,
          };
          pools.set(pool.id, pool);
        }
        return { id: pool.id };
      },
    },
    brand: {
      findMany: async ({ where }: any) => brands
        .filter(brand => where.id?.in ? where.id.in.includes(brand.id) : true)
        .filter(brand => where.country === undefined || brand.country === where.country)
        .filter(brand => where.kaType === undefined || brand.kaType === where.kaType)
        .filter(brand => where.deletedAt === undefined || brand.deletedAt === where.deletedAt)
        .map(brand => ({ id: brand.id })),
    },
    autoOpenPoolBrand: {
      findMany: async ({ where }: any) => [...getMembership(where.poolId)]
        .filter(brandId => where.brandId?.in ? where.brandId.in.includes(brandId) : true)
        .map(brandId => ({ brandId })),
      deleteMany: async ({ where }: any) => {
        operationLog.push('membership.delete');
        deleteFromSet(getMembership(where.poolId), where.brandId);
        return { count: 1 };
      },
      createMany: async ({ data }: any) => {
        operationLog.push('membership.create');
        data.forEach(({ poolId, brandId }: any) => getMembership(poolId).add(brandId));
        return { count: data.length };
      },
    },
    autoOpenPoolBrandExclusion: {
      findMany: async ({ where }: any) => [...getExclusions(where.poolId)]
        .filter(brandId => where.brandId?.in ? where.brandId.in.includes(brandId) : true)
        .map(brandId => ({ brandId })),
      deleteMany: async ({ where }: any) => {
        operationLog.push('exclusion.delete');
        deleteFromSet(getExclusions(where.poolId), where.brandId);
        return { count: 1 };
      },
      createMany: async ({ data }: any) => {
        operationLog.push('exclusion.create');
        data.forEach(({ poolId, brandId }: any) => getExclusions(poolId).add(brandId));
        return { count: data.length };
      },
    },
    autoOpenExecution: {
      findFirst: async ({ where }: any) => {
        operationLog.push('execution.find-active');
        return executions.find(execution => (
          execution.poolId === where.poolId && where.status.in.includes(execution.status)
        )) ?? null;
      },
      create: async ({ data }: any) => {
        operationLog.push('execution.create');
        const execution = {
          id: `execution-${++executionSequence}`,
          ...data,
        };
        executions.push(execution);
        return execution;
      },
      update: async ({ where, data }: any) => {
        operationLog.push('execution.update');
        const execution = executions.find(value => value.id === where.id);
        if (!execution) throw new Error('Execution not found');
        Object.assign(execution, data);
        return execution;
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      const poolSnapshot = new Map([...pools].map(([id, pool]) => [id, { ...pool, executionHours: [...pool.executionHours] }]));
      const membershipSnapshot = cloneMapOfSets(memberships);
      const exclusionSnapshot = cloneMapOfSets(exclusions);
      const executionSnapshot = executions.map(execution => ({ ...execution }));
      operationLog.push('transaction.begin');
      transactionActive = true;
      try {
        const result = await callback(tx);
        operationLog.push('transaction.commit');
        return result;
      } catch (error) {
        pools.clear();
        poolSnapshot.forEach((pool, id) => pools.set(id, pool));
        restoreMapOfSets(memberships, membershipSnapshot);
        restoreMapOfSets(exclusions, exclusionSnapshot);
        executions.splice(0, executions.length, ...executionSnapshot);
        operationLog.push('transaction.rollback');
        throw error;
      } finally {
        transactionActive = false;
      }
    },
  };
  const queue = {
    add: async () => {
      queueTransactionStates.push(transactionActive);
      operationLog.push('queue.add');
    },
  };
  const service = new AutoOpenPoolsService(
    prisma as never,
    {} as never,
    { get: () => serverRemoteWritesEnabled ? 'true' : undefined } as never,
    queue as never,
    {} as never,
  );
  return {
    service,
    brands,
    pools,
    memberships,
    exclusions,
    executions,
    operationLog,
    lockQueries,
    queueTransactionStates,
    setServerRemoteWritesEnabled: (enabled: boolean) => { serverRemoteWritesEnabled = enabled; },
  };
}

test('managed pool membership uses deltas so a new KA from a stale modal is not excluded', async () => {
  const value = managedPoolHarness();
  // The modal opened with A+B. C became eligible before the operator saved the
  // intended removal of B, so a full A-only snapshot would be stale.
  value.brands.push({
    id: BRAND_C,
    brandId: 'external-c',
    brandName: 'Brand C',
    country: Country.MX,
    kaType: KaType.KA,
    deletedAt: null,
  });

  await assert.rejects(
    value.service.update(MX_POOL_ID, { brandIds: [BRAND_A] }),
    (error: any) => error?.getStatus?.() === 409,
  );
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B]);
  assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], []);

  value.operationLog.length = 0;
  await value.service.update(MX_POOL_ID, {
    executionHours: [9, 15],
    excludeBrandIds: [BRAND_B],
  });
  assert.equal(value.operationLog[0], 'transaction.begin');
  assert.ok(value.operationLog.indexOf('pool.lock') < value.operationLog.indexOf('execution.find-active'));
  assert.ok(value.operationLog.indexOf('execution.find-active') < value.operationLog.indexOf('exclusion.create'));
  assert.match(value.lockQueries.at(-1)!, /FOR UPDATE/);
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!], [BRAND_A]);
  assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], [BRAND_B]);

  await value.service.ensureManagedKaPools();
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_C]);
  assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], [BRAND_B]);

  await value.service.update(MX_POOL_ID, { includeBrandIds: [BRAND_B] });
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B, BRAND_C]);
  assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], []);
});

test('managed deltas validate overlap and KA/country/deleted eligibility atomically', async () => {
  const value = managedPoolHarness();
  const initialMembership = [...value.memberships.get(MX_POOL_ID)!].sort();

  await assert.rejects(
    value.service.update(MX_POOL_ID, {
      includeBrandIds: [BRAND_A],
      excludeBrandIds: [BRAND_A],
    }),
    (error: any) => error?.getStatus?.() === 400,
  );
  for (const invalidBrandId of [NON_KA_BRAND, CROSS_COUNTRY_BRAND, DELETED_BRAND]) {
    await assert.rejects(
      value.service.update(MX_POOL_ID, { excludeBrandIds: [invalidBrandId] }),
      (error: any) => error?.getStatus?.() === 400,
    );
  }
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), initialMembership);
  assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], []);
});

test('custom pools retain replacement semantics and reject managed deltas', async () => {
  const value = managedPoolHarness();
  await value.service.update(CUSTOM_POOL_ID, { brandIds: [BRAND_A, BRAND_A] });
  assert.deepEqual([...value.memberships.get(CUSTOM_POOL_ID)!], [BRAND_A]);

  await assert.rejects(
    value.service.update(CUSTOM_POOL_ID, { excludeBrandIds: [BRAND_A] }),
    (error: any) => error?.getStatus?.() === 400,
  );
  assert.deepEqual([...value.memberships.get(CUSTOM_POOL_ID)!], [BRAND_A]);
});

test('pending and running executions reject real membership changes and roll back other fields', async () => {
  for (const status of ['pending', 'running']) {
    const value = managedPoolHarness();
    value.executions.push({ id: `active-${status}`, poolId: MX_POOL_ID, status });

    await assert.rejects(
      value.service.update(MX_POOL_ID, {
        name: `Should roll back ${status}`,
        executionHours: [7],
        excludeBrandIds: [BRAND_B],
      }),
      (error: any) => error?.getStatus?.() === 409 && error.message.includes(status),
    );

    assert.equal(value.pools.get(MX_POOL_ID)!.name, 'KA Auto Open — Mexico');
    assert.deepEqual(value.pools.get(MX_POOL_ID)!.executionHours, [3, 9, 15, 21]);
    assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B]);
    assert.deepEqual([...value.exclusions.get(MX_POOL_ID)!], []);
    assert.ok(value.operationLog.indexOf('pool.lock') < value.operationLog.indexOf('execution.find-active'));
    assert.equal(value.operationLog.at(-1), 'transaction.rollback');
  }
});

test('schedule-only and membership no-op updates remain allowed during an active execution', async () => {
  const value = managedPoolHarness();
  value.executions.push({ id: 'active-running', poolId: MX_POOL_ID, status: 'running' });

  await value.service.update(MX_POOL_ID, {
    executionHours: [8, 14],
    includeBrandIds: [BRAND_A],
    excludeBrandIds: [],
  });

  assert.deepEqual(value.pools.get(MX_POOL_ID)!.executionHours, [8, 14]);
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B]);
  assert.equal(value.operationLog.includes('execution.find-active'), false);
  assert.equal(value.operationLog.at(-1), 'transaction.commit');
});

test('managed reconciliation defers membership drift until the active execution finishes', async () => {
  const value = managedPoolHarness();
  value.brands.push({
    id: BRAND_C,
    brandId: 'external-c',
    brandName: 'Brand C',
    country: Country.MX,
    kaType: KaType.KA,
    deletedAt: null,
  });
  value.executions.push({ id: 'active-pending', poolId: MX_POOL_ID, status: 'pending' });

  await value.service.ensureManagedKaPools();
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B]);
  const upsertIndex = value.operationLog.indexOf('pool.upsert:ka-MX');
  const lockIndex = value.operationLog.indexOf('pool.lock');
  const rereadIndex = value.operationLog.indexOf('pool.find');
  const activeIndex = value.operationLog.indexOf('execution.find-active');
  assert.ok(upsertIndex < lockIndex);
  assert.ok(lockIndex < rereadIndex);
  assert.ok(rereadIndex < activeIndex);

  value.executions[0].status = 'done';
  await value.service.ensureManagedKaPools();
  assert.deepEqual([...value.memberships.get(MX_POOL_ID)!].sort(), [BRAND_A, BRAND_B, BRAND_C]);
});

test('manual execution locks and rereads the pool, checks active state, commits pending, then queues', async () => {
  const value = managedPoolHarness();
  value.service.ensureManagedKaPools = async () => undefined;
  value.pools.get(MX_POOL_ID)!.dryRun = false;
  value.setServerRemoteWritesEnabled(true);

  const execution = await value.service.runNow(MX_POOL_ID);

  assert.equal(execution.status, 'pending');
  assert.equal(execution.dryRun, false);
  assert.equal(execution.remoteWritesEnabled, true);
  assert.deepEqual(value.queueTransactionStates, [false]);
  const lockIndex = value.operationLog.indexOf('pool.lock');
  const activeIndex = value.operationLog.indexOf('execution.find-active');
  const createIndex = value.operationLog.indexOf('execution.create');
  const commitIndex = value.operationLog.indexOf('transaction.commit');
  const queueIndex = value.operationLog.indexOf('queue.add');
  assert.ok(lockIndex < activeIndex);
  assert.ok(activeIndex < createIndex);
  assert.ok(createIndex < commitIndex);
  assert.ok(commitIndex < queueIndex);
  assert.match(value.lockQueries[0], /FOR UPDATE/);

  await assert.rejects(
    value.service.runNow(MX_POOL_ID),
    (error: any) => error?.getStatus?.() === 400 && error.message.includes('pending'),
  );
  assert.equal(value.executions.length, 1);
  assert.deepEqual(value.queueTransactionStates, [false]);
});

test('scheduled execution skips inactive or already-active pools inside the locked transaction', async () => {
  const value = managedPoolHarness();
  const slot = new Date('2026-08-20T15:00:00.000Z');

  assert.equal(await value.service.runScheduled(MX_POOL_ID, slot), null);
  value.pools.get(MX_POOL_ID)!.active = true;
  value.executions.push({ id: 'active-running', poolId: MX_POOL_ID, status: 'running' });
  assert.equal(await value.service.runScheduled(MX_POOL_ID, slot), null);

  assert.deepEqual(value.queueTransactionStates, []);
  assert.equal(value.executions.length, 1);
  assert.ok(value.operationLog.indexOf('pool.lock') >= 0);
  assert.ok(value.operationLog.indexOf('execution.find-active') >= 0);
});

test('fresh live-write gate is enforced after taking the pool lock', async () => {
  const value = managedPoolHarness();
  value.service.ensureManagedKaPools = async () => undefined;
  value.pools.get(MX_POOL_ID)!.dryRun = false;

  await assert.rejects(
    value.service.runNow(MX_POOL_ID),
    (error: any) => error?.getStatus?.() === 400 && error.message.includes('disabled'),
  );
  assert.equal(value.executions.length, 0);
  assert.deepEqual(value.queueTransactionStates, []);
  assert.ok(value.operationLog.indexOf('pool.lock') < value.operationLog.indexOf('transaction.rollback'));
});
