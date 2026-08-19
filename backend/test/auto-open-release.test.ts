import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AutoOpenStatus } from '@prisma/client';
import {
  AutoOpenProcessor,
  buildEmergencyProtection,
  LIVE_AUTO_OPEN_EMERGENCY_STATUSES,
} from '../src/integrations/auto-open.processor';
import { hourInTimezone } from '../src/integrations/auto-open.scheduler';

interface FakeBrandRun {
  id: string;
  executionId: string;
  brandId: string;
  brandName: string;
  status: AutoOpenStatus;
  totalShops: number;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  errorMessage: string | null;
  shopErrors: unknown[];
  createdAt: Date;
}

function fixture(dryRun: boolean, serverWritesEnabled: boolean, dynamicEmergency = false) {
  const queued: Array<{ name: string; data: { executionId: string; brandRunId: string } }> = [];
  const execution: Record<string, any> = {
    id: 'execution-1', status: AutoOpenStatus.pending, dryRun,
    remoteWritesEnabled: !dryRun && serverWritesEnabled,
    totalBrands: 0, brandsCompleted: 0, brandsFailed: 0, totalShops: 0,
    shopsOpened: 0, shopsWouldOpen: 0, shopsSkippedEmergency: 0, shopsFailed: 0,
    progressPercent: 0,
    pool: { id: 'pool-1', name: 'KA test', country: 'MX', webhookId: null },
  };
  const brandRuns: FakeBrandRun[] = [];
  const matchesStatus = (where: any, actual: AutoOpenStatus) => !where?.status || where.status === actual;
  const prisma = {
    autoOpenExecution: {
      updateMany: async ({ where, data }: any) => {
        if (where.id !== execution.id || !matchesStatus(where, execution.status)) return { count: 0 };
        Object.assign(execution, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        assert.equal(where.id, execution.id);
        Object.assign(execution, data);
        return execution;
      },
      findUnique: async ({ where, include }: any) => {
        if (where.id !== execution.id) return null;
        if (include?.pool?.include?.brands) {
          return {
            ...execution,
            pool: {
              ...execution.pool,
              brands: [{ brand: { id: 'brand-1', brandName: 'Test Brand', deletedAt: null } }],
            },
          };
        }
        if (include?.brandRuns) return { ...execution, brandRuns: [...brandRuns] };
        return { ...execution };
      },
    },
    autoOpenBrandExecution: {
      createMany: async ({ data }: any) => {
        data.forEach((item: any) => brandRuns.push({
          id: `run-${item.brandId}`,
          ...item,
          status: AutoOpenStatus.pending,
          totalShops: 0, shopsProcessed: 0, shopsOpened: 0, shopsWouldOpen: 0,
          shopsSkippedEmergency: 0, shopsFailed: 0, errorMessage: null, shopErrors: [],
          createdAt: new Date('2026-08-19T00:00:00Z'),
        }));
        return { count: data.length };
      },
      findMany: async ({ where }: any) => brandRuns
        .filter(run => run.executionId === where.executionId && run.status === where.status)
        .map(run => ({ id: run.id })),
      findUnique: async ({ where }: any) => brandRuns.find(run => run.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const run = brandRuns.find(item => item.id === where.id && item.executionId === where.executionId);
        if (!run || !matchesStatus(where, run.status)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        const run = brandRuns.find(item => item.id === where.id);
        assert.ok(run);
        Object.assign(run, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return run;
      },
    },
    brand: {
      findFirst: async () => ({
        id: 'brand-1', brandName: 'Test Brand',
        application: { appId: 'app-1', appSecret: 'secret', deletedAt: null },
        shops: [{ id: 'shop-uuid-1', shopId: '5700000000000000001', appShopId: 'shop-external-1' }],
      }),
    },
    storeEmergency: {
      findMany: async () => [],
      findFirst: async () => dynamicEmergency ? { id: 'emergency-1' } : null,
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const config = { get: (key: string) => key === 'AUTO_OPEN_REMOTE_WRITE_ENABLED' && serverWritesEnabled ? 'true' : '' };
  const webhooks = { sendToWebhook: async () => undefined };
  const queue = { addBulk: async (jobs: typeof queued) => { queued.push(...jobs); } };
  return {
    processor: new AutoOpenProcessor(prisma as never, config as never, webhooks as never, queue as never),
    execution, brandRuns, queued,
  };
}

function successfulDidiFetch(calls: Array<{ url: string; method: string }>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }), { status: 200 });
    }
    if (url.includes('/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'token' } }), { status: 200 });
    }
    if (url.includes('/shop/setStatus')) {
      return new Response(JSON.stringify({ errno: 0 }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

async function prepareAndRunBrand(value: ReturnType<typeof fixture>) {
  await value.processor.process({ name: 'prepare-pool', data: { executionId: 'execution-1' } } as never);
  assert.equal(value.queued.length, 1);
  await value.processor.process({ name: 'run-brand', data: value.queued[0].data } as never);
}

test('dry-run segments work by brand, checkpoints progress, and never calls DiDi', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const value = fixture(true, false);
  await prepareAndRunBrand(value);
  assert.equal(calls.length, 0);
  assert.equal(value.execution.status, AutoOpenStatus.done);
  assert.equal(value.execution.progressPercent, 100);
  assert.equal(value.execution.shopsWouldOpen, 1);
  assert.equal(value.execution.shopsOpened, 0);
  assert.equal(value.brandRuns[0].status, AutoOpenStatus.done);
});

test('live execution opens once only with both remote-write gates enabled', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const value = fixture(false, true);
  await prepareAndRunBrand(value);
  assert.equal(calls.filter(call => call.url.includes('/shop/setStatus')).length, 1);
  assert.equal(value.execution.shopsOpened, 1);
  assert.equal(value.execution.status, AutoOpenStatus.done);
});

test('live execution skips a shop when an emergency appears immediately before opening', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const value = fixture(false, true, true);
  await prepareAndRunBrand(value);
  assert.equal(calls.filter(call => call.url.includes('/shop/setStatus')).length, 0);
  assert.equal(value.execution.shopsSkippedEmergency, 1);
  assert.equal(value.execution.shopsOpened, 0);
});

test('partial_restored is not a live emergency for Auto Open', () => {
  assert.equal(LIVE_AUTO_OPEN_EMERGENCY_STATUSES.includes('partial_restored' as never), false);
  assert.equal(LIVE_AUTO_OPEN_EMERGENCY_STATUSES.includes('restore_failed' as never), false);
  assert.deepEqual([...LIVE_AUTO_OPEN_EMERGENCY_STATUSES], [
    'pending', 'running', 'offline', 'partial_success', 'restoring',
  ]);
});

test('live preparation fails closed when the server write gate is disabled', async () => {
  const value = fixture(false, false);
  await assert.rejects(
    value.processor.process({ name: 'prepare-pool', data: { executionId: 'execution-1' } } as never),
    /remote writes are disabled/,
  );
  assert.equal(value.execution.status, AutoOpenStatus.failed);
});

test('emergency protection separates full-brand and selected-store scopes', () => {
  const result = buildEmergencyProtection([
    { brandId: 'brand-all', mode: 'all_brand', targets: [] },
    { brandId: 'brand-list', mode: 'shop_list', targets: [{ shopId: 'shop-1' }, { shopId: 'shop-2' }] },
  ]);
  assert.equal(result.blockedBrands.has('brand-all'), true);
  assert.deepEqual([...result.blockedShopsByBrand.get('brand-list')!], ['shop-1', 'shop-2']);
});

test('Mexico local schedule is deterministic', () => {
  assert.equal(hourInTimezone(new Date('2026-08-18T15:00:00.000Z'), 'America/Mexico_City'), 9);
});
