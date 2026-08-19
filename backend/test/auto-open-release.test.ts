import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AutoOpenProcessor, buildEmergencyProtection } from '../src/integrations/auto-open.processor';
import { hourInTimezone } from '../src/integrations/auto-open.scheduler';

function fixture(dryRun: boolean, serverWritesEnabled: boolean, dynamicEmergency = false) {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    autoOpenExecution: {
      updateMany: async (args: Record<string, unknown>) => {
        writes.push(args);
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        writes.push(args);
        return args;
      },
      findUnique: async () => ({
        id: 'execution-1',
        dryRun,
        remoteWritesEnabled: !dryRun && serverWritesEnabled,
        pool: {
          id: 'pool-1',
          name: 'KA test',
          country: 'MX',
          webhookId: null,
          brands: [{
            brand: {
              id: 'brand-1',
              brandName: 'Test Brand',
              application: { appId: 'app-1', appSecret: 'secret' },
              shops: [{ id: 'shop-uuid-1', appShopId: 'shop-external-1' }],
            },
          }],
        },
      }),
    },
    storeEmergency: {
      findMany: async () => [],
      findFirst: async () => dynamicEmergency ? { id: 'emergency-1' } : null,
    },
  };
  const config = {
    get: (key: string) => key === 'AUTO_OPEN_REMOTE_WRITE_ENABLED' && serverWritesEnabled ? 'true' : '',
  };
  const webhooks = { sendToWebhook: async () => undefined };
  return { processor: new AutoOpenProcessor(prisma as never, config as never, webhooks as never), writes };
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

test('dry-run counts eligible local stores without calling DiDi status or setStatus', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const { processor, writes } = fixture(true, false);

  await processor.process({ data: { executionId: 'execution-1' } } as never);

  assert.equal(calls.filter(call => call.url.includes('/shop/detail')).length, 0);
  assert.equal(calls.filter(call => call.url.includes('/authtoken/')).length, 0);
  assert.equal(calls.filter(call => call.url.includes('/shop/setStatus')).length, 0);
  const completion = writes.find(item => JSON.stringify(item).includes('shopsWouldOpen')) as { data: Record<string, number> };
  assert.equal(completion.data.shopsWouldOpen, 1);
  assert.equal(completion.data.shopsOpened, 0);
});

test('live execution sends exactly one opening POST only with both safety gates enabled', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const { processor, writes } = fixture(false, true);

  await processor.process({ data: { executionId: 'execution-1' } } as never);

  const openingCalls = calls.filter(call => call.url.includes('/shop/setStatus'));
  assert.equal(calls.filter(call => call.url.includes('/shop/detail')).length, 0);
  assert.equal(openingCalls.length, 1);
  assert.equal(openingCalls[0].method, 'POST');
  const completion = writes.find(item => JSON.stringify(item).includes('shopsWouldOpen')) as { data: Record<string, number> };
  assert.equal(completion.data.shopsOpened, 1);
});

test('live execution skips a store when an emergency appears immediately before opening', async t => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = successfulDidiFetch(calls) as typeof fetch;
  const { processor, writes } = fixture(false, true, true);

  await processor.process({ data: { executionId: 'execution-1' } } as never);

  assert.equal(calls.filter(call => call.url.includes('/shop/detail')).length, 0);
  assert.equal(calls.filter(call => call.url.includes('/shop/setStatus')).length, 0);
  const completion = writes.find(item => JSON.stringify(item).includes('shopsSkippedEmergency')) as {
    data: Record<string, number>;
  };
  assert.equal(completion.data.shopsSkippedEmergency, 1);
  assert.equal(completion.data.shopsOpened, 0);
});

test('live execution fails closed when the server write gate is disabled', async () => {
  const { processor } = fixture(false, false);
  await assert.rejects(
    processor.process({ data: { executionId: 'execution-1' } } as never),
    /remote writes are disabled/,
  );
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
