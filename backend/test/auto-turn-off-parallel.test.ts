import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AutoTurnOffCoordinator } from '../src/integrations/auto-turn-off.processor';
import { STOCK_REQUEST_COOLDOWN_MS, waitForShopStockSlot } from '../src/integrations/auto-turn-off-stock-limiter';

test('stock requests to the same shop are separated by the Redis cooldown', async () => {
  let now = 0;
  const reserved = new Map<string, number>();
  const registered: string[] = [];
  const store = {
    defineCommand: (name: string, definition: { lua: string }) => {
      registered.push(name);
      assert.match(definition.lua, /redis\.call\('PTTL'/);
      assert.match(definition.lua, /redis\.call\('SET'/);
    },
    runCommand: async (_name: string, [key, duration]: string[]) => {
      const expiry = reserved.get(key) ?? 0;
      if (expiry > now) return expiry - now;
      reserved.set(key, now + Number(duration));
      return 0;
    },
  };
  const waits: number[] = [];
  const pause = async (ms: number) => { waits.push(ms); now += ms; };
  const ensureActive = async () => {};

  await waitForShopStockSlot(store, 'app', 'shop-a', ensureActive, pause);
  await waitForShopStockSlot(store, 'app', 'shop-b', ensureActive, pause);
  assert.equal(now, 0, 'different shops can run immediately');
  await waitForShopStockSlot(store, 'app', 'shop-a', ensureActive, pause);
  assert.equal(now, STOCK_REQUEST_COOLDOWN_MS);
  assert.ok(waits.every(ms => ms <= 5_000));
  assert.deepEqual(registered, ['reserveAutoTurnOffStockSlot']);
});

test('coordinator queues all mapped shops in batches instead of one at a time', async () => {
  const shopIds = Array.from({ length: 205 }, (_, index) => `shop-${index}`);
  const batches: Array<Array<{ data: { shopExecutionId: string }; opts: { jobId: string } }>> = [];
  let createdShops: Array<{ id: string; shopId: string }> = [];
  const execution = {
    id: 'execution-1', status: 'running', trigger: 'scheduled',
    pool: { country: 'MX' },
    rule: {
      id: 'rule-1', name: 'Oxxo', brandId: 'brand-1', brand: { application: { appId: 'app', appSecret: 'secret' } },
      stockEndpoint: 'setstockSync', shopIds, upcs: ['upc-1', 'upc-2'], nextRunAt: new Date(), endsAt: null,
    },
  };
  const prisma = {
    autoTurnOffExecution: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => execution,
    },
    autoTurnOffRule: { update: async () => ({}) },
    shop: { findMany: async () => shopIds.map(shopId => ({ shopId, appShopId: `app-${shopId}` })) },
    $transaction: async (action: (tx: any) => Promise<void>) => action({
      autoTurnOffExecution: { findUnique: async () => ({ status: 'running' }), update: async () => ({}) },
      autoTurnOffShopExecution: { createMany: async ({ data }: any) => { createdShops = data; } },
    }),
  };
  const queue = {
    addBulk: async (jobs: any[]) => { batches.push(jobs); },
    add: async () => { throw new Error('advance job is unnecessary for mapped shops'); },
  };
  const coordinator = new AutoTurnOffCoordinator(prisma as any, { get: () => '' } as any, queue as any);
  await coordinator.process(execution.id);

  assert.equal(createdShops.length, 205);
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
  const queuedIds = batches.flat().map(job => job.data.shopExecutionId);
  assert.equal(new Set(queuedIds).size, 205);
  assert.deepEqual(new Set(queuedIds), new Set(createdShops.map(shop => shop.id)));
});
