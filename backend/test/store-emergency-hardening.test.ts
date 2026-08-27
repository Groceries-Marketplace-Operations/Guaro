import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StoreEmergencyProcessor } from '../src/integrations/store-emergency.processor';
import { StoreEmergencyScheduler } from '../src/integrations/store-emergency.scheduler';

type TargetWrite = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

function didiFetch(detailStatuses: number[]) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }), { status: 200 });
    }
    if (url.includes('/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'token' } }), { status: 200 });
    }
    if (url.includes('/shop/shop/detail')) {
      const bizStatus = detailStatuses.shift();
      assert.notEqual(bizStatus, undefined, 'test must provide every expected readback');
      return new Response(JSON.stringify({ errno: 0, data: { biz_status: bizStatus } }), { status: 200 });
    }
    if (url.includes('/shop/shop/setStatus')) {
      return new Response(JSON.stringify({ errno: 0 }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

function processorFixture(openingPermit?: (options: Record<string, unknown>) => Promise<unknown>) {
  const writes: TargetWrite[] = [];
  const events: Array<Record<string, unknown>> = [];
  const updateMany = async ({ where, data }: TargetWrite) => {
    writes.push({ where, data });
    return { count: 1 };
  };
  const tx = {
    storeEmergencyTarget: { updateMany },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: { updateMany: async () => ({ count: 1 }) },
    storeEmergencyTarget: {
      updateMany,
      findUnique: async () => ({ offlineAttempts: 1, restoreAttempts: 1 }),
    },
    storeEmergencyEvent: tx.storeEmergencyEvent,
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const guard = {
    withOpeningPermit: openingPermit ?? (async ({ execute }: { execute: () => Promise<unknown> }) => execute()),
  };
  return {
    processor: new StoreEmergencyProcessor(prisma as never, { get: () => '' } as never, guard as never),
    writes,
    events,
  };
}

async function processTarget(
  processor: StoreEmergencyProcessor,
  action: 'offline' | 'restore',
  initialRestoreStatus: string,
) {
  await (processor as unknown as {
    processTarget: (
      emergencyId: string,
      targetId: string,
      shopId: string,
      appShopId: string,
      appId: string,
      appSecret: string,
      action: 'offline' | 'restore',
      initialRestoreStatus: string,
      actorId: string | null,
      source: string,
    ) => Promise<void>;
  }).processTarget(
    'emergency-1',
    'target-1',
    'shop-1',
    'app-shop-1',
    'app-1',
    'secret',
    action,
    initialRestoreStatus,
    'actor-1',
    'user',
  );
}

test('preflight preserves a closure that existed before the emergency and never sends POST', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const fixture = processorFixture(async () => assert.fail('restore permit must not be used for shutdown'));

  await processTarget(fixture.processor, 'offline', 'pending');

  assert.equal(remote.calls.some(call => call.url.includes('/setStatus')), false);
  const completed = fixture.writes.find(write => write.data.offlineStatus === 'done');
  assert.equal(completed?.data.restoreStatus, 'not_required');
  assert.equal(fixture.events.at(-1)?.type, 'target_shutdown_succeeded');
  assert.equal((fixture.events.at(-1)?.metadata as Record<string, unknown>).providerWriteAttempted, false);
});

test('preflight reconciles a crash after OFF ownership without duplicating POST', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const fixture = processorFixture();

  await processTarget(fixture.processor, 'offline', 'required');

  assert.equal(remote.calls.some(call => call.url.includes('/setStatus')), false);
  const completed = fixture.writes.find(write => write.data.offlineStatus === 'done');
  assert.equal(completed?.data.restoreStatus, 'pending');
});

test('shutdown persists ownership before POST and requires DiDi readback after success', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([1, 1, 2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const fixture = processorFixture();

  await processTarget(fixture.processor, 'offline', 'pending');

  const ownershipIndex = fixture.writes.findIndex(write => write.data.restoreStatus === 'required');
  const completionIndex = fixture.writes.findIndex(write => write.data.offlineStatus === 'done');
  assert.ok(ownershipIndex >= 0 && completionIndex > ownershipIndex);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 3);
  assert.equal(fixture.writes[completionIndex].data.restoreStatus, 'pending');
});

test('emergency restore takes the opening permit and verifies the remote online state', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2, 1]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  let permit: Record<string, unknown> | undefined;
  const fixture = processorFixture(async options => {
    permit = options;
    return (options.execute as () => Promise<unknown>)();
  });

  await processTarget(fixture.processor, 'restore', 'pending');

  assert.equal(permit?.shopId, 'shop-1');
  assert.equal(permit?.allowedEmergencyId, 'emergency-1');
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(fixture.writes.some(write => write.data.restoreStatus === 'done'), true);
});

test('BullMQ failed event is diagnostic only and sanitizes credentials', async () => {
  const events: Array<Record<string, unknown>> = [];
  const processor = new StoreEmergencyProcessor({
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  } as never, {} as never, {} as never);

  await processor.failed({
    id: 'job-1',
    attemptsMade: 1,
    data: { emergencyId: 'emergency-1', action: 'offline', source: 'system' },
  } as never, new Error('redis://:password@host auth_token=secret'));

  assert.equal(events[0].type, 'worker_failed');
  assert.equal((events[0].metadata as Record<string, unknown>).watchdogRecoveryExpected, true);
  assert.doesNotMatch(String(events[0].message), /password|secret/);
});

test('target lease renewal uses the exact timestamp and active parent phase in its CAS', async () => {
  const fixture = processorFixture();
  const leaseAt = new Date('2026-08-26T12:00:00.000Z');
  await (fixture.processor as unknown as {
    renewTargetLease: (lease: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }).renewTargetLease({
    emergencyId: 'emergency-1',
    targetId: 'target-1',
    action: 'offline',
    updatedAt: leaseAt,
  });

  assert.equal(fixture.writes[0].where.updatedAt, leaseAt);
  assert.deepEqual(fixture.writes[0].where.emergency, {
    id: 'emergency-1', status: 'running', finishedAt: null,
  });
  assert.equal(fixture.writes[0].where.offlineStatus, 'running');
});

test('restore finalization treats not_required targets as resolved without an error', async () => {
  let parentUpdate: Record<string, unknown> | undefined;
  let finalEvent: Record<string, unknown> | undefined;
  const tx = {
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        parentUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        finalEvent = data;
        return data;
      },
    },
  };
  const processor = new StoreEmergencyProcessor({
    storeEmergency: {
      findUnique: async () => ({ id: 'emergency-1', status: 'restoring', restoredAt: null }),
    },
    storeEmergencyTarget: {
      groupBy: async () => [{
        offlineStatus: 'done', restoreStatus: 'not_required', _count: { _all: 2 },
      }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);

  await (processor as unknown as {
    finalize: (id: string, action: string, job: Record<string, unknown>, attempt: number) => Promise<void>;
  }).finalize('emergency-1', 'restore', {
    id: 'job-1', data: { emergencyId: 'emergency-1', action: 'restore', source: 'system' },
  }, 1);

  assert.equal(parentUpdate?.status, 'restored');
  assert.equal(parentUpdate?.errorMessage, null);
  const metadata = finalEvent?.metadata as Record<string, unknown>;
  assert.equal(metadata.restoreRequired, 0);
  assert.equal(metadata.restoreNotRequired, 2);
  assert.match(String(finalEvent?.message), /No stores required reopening/);
});

test('shutdown finalization keeps an entirely ambiguous owned closure live for reconciliation', async () => {
  let parentUpdate: Record<string, unknown> | undefined;
  let finalEvent: Record<string, unknown> | undefined;
  const tx = {
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        parentUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        finalEvent = data;
        return data;
      },
    },
  };
  const processor = new StoreEmergencyProcessor({
    storeEmergency: {
      findUnique: async () => ({ id: 'emergency-1', status: 'running', offlineAt: null }),
    },
    storeEmergencyTarget: {
      groupBy: async () => [{
        offlineStatus: 'failed', restoreStatus: 'required', _count: { _all: 1 },
      }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);

  await (processor as unknown as {
    finalize: (id: string, action: string, job: Record<string, unknown>, attempt: number) => Promise<void>;
  }).finalize('emergency-1', 'offline', {
    id: 'job-ambiguous', data: { emergencyId: 'emergency-1', action: 'offline', source: 'user' },
  }, 1);

  assert.equal(parentUpdate?.status, 'partial_success');
  assert.equal(parentUpdate?.finishedAt, null);
  assert.equal(finalEvent?.type, 'shutdown_partial');
  assert.equal((finalEvent?.metadata as Record<string, unknown>).ambiguousOwned, 1);
});

test('periodic reconciliation queues only live offline emergencies with one coalesced job id', async () => {
  let query: Record<string, unknown> | undefined;
  let queued: { data: Record<string, unknown>; options: Record<string, unknown> } | undefined;
  const scheduler = new StoreEmergencyScheduler({
    storeEmergency: {
      findMany: async (input: Record<string, unknown>) => {
        query = input;
        return [{ id: 'emergency-1' }];
      },
    },
  } as never, {
    add: async (_name: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
      queued = { data, options };
      return { id: options.jobId, timestamp: Date.now() };
    },
  } as never);

  await scheduler.reconcileOfflineEmergencies();

  const where = query?.where as Record<string, unknown>;
  assert.deepEqual(where.status, { in: ['offline', 'partial_success'] });
  assert.equal(where.finishedAt, null);
  assert.equal(queued?.data.action, 'reconcile');
  assert.equal(queued?.options.jobId, 'emergency-1-reconcile');
  assert.equal(queued?.options.attempts, 1);
  assert.equal(queued?.options.removeOnComplete, true);
});

test('periodic reconciliation advances a bounded unique cursor without mutable offset gaps', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const queuedIds: string[] = [];
  const firstPage = Array.from({ length: 101 }, (_, index) => ({
    id: `emergency-${String(index).padStart(3, '0')}`,
  }));
  const scheduler = new StoreEmergencyScheduler({
    storeEmergency: {
      findMany: async (input: Record<string, unknown>) => {
        queries.push(input);
        return queries.length === 1 ? firstPage : [{ id: 'emergency-100' }];
      },
    },
  } as never, {
    add: async (_name: string, data: { emergencyId: string }, options: Record<string, unknown>) => {
      queuedIds.push(data.emergencyId);
      return { id: options.jobId, timestamp: Date.now() };
    },
  } as never);

  await scheduler.reconcileOfflineEmergencies();
  await scheduler.reconcileOfflineEmergencies();

  assert.equal(queries.length, 2);
  assert.equal(queries[0].take, 101);
  assert.deepEqual(queries[0].orderBy, { id: 'asc' });
  assert.deepEqual(queries[1].cursor, { id: 'emergency-099' });
  assert.equal(queries[1].skip, 1);
  assert.equal(queuedIds.length, 101);
  assert.equal(queuedIds.at(-1), 'emergency-100');
});

test('all-brand reconciliation appends newly discovered stores as unowned until a write is needed', async () => {
  const order: string[] = [];
  let createData: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => { order.push('lock'); return 1; },
    storeEmergency: {
      findFirst: async () => {
        order.push('parent');
        return { id: 'emergency-1', brandId: 'brand-1', mode: 'all_brand' };
      },
    },
    shop: {
      findMany: async () => [{ id: 'shop-1' }, { id: 'shop-2' }],
    },
    storeEmergencyTarget: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        order.push('targets');
        createData = data;
        return { count: data.length };
      },
    },
    storeEmergencyEvent: { create: async () => ({}) },
  };
  const processor = new StoreEmergencyProcessor({
    storeEmergency: { findUnique: async () => ({ brandId: 'brand-1' }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);

  const prepared = await (processor as unknown as {
    prepareReconciliation: (id: string) => Promise<{ appended: number } | null>;
  }).prepareReconciliation('emergency-1');

  assert.equal(prepared?.appended, 2);
  assert.deepEqual(order.slice(0, 3), ['lock', 'lock', 'parent']);
  assert.equal(order.at(-1), 'targets');
  assert.deepEqual(createData.map(value => ({
    offlineStatus: value.offlineStatus,
    restoreStatus: value.restoreStatus,
  })), [
    { offlineStatus: 'pending', restoreStatus: 'not_required' },
    { offlineStatus: 'pending', restoreStatus: 'not_required' },
  ]);
});

test('reconciliation always reserves capacity to inspect healthy targets during persistent failures', () => {
  const processor = new StoreEmergencyProcessor({} as never, {} as never, {} as never);
  const at = new Date('2026-08-26T12:00:00Z');
  const targets = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `urgent-${index}`,
      offlineStatus: 'failed',
      restoreStatus: 'required',
      offlineError: 'still online',
      updatedAt: at,
      shop: { id: `urgent-shop-${index}`, appShopId: `urgent-app-${index}` },
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `healthy-${index}`,
      offlineStatus: 'done',
      restoreStatus: 'pending',
      offlineError: null,
      updatedAt: at,
      shop: { id: `healthy-shop-${index}`, appShopId: `healthy-app-${index}` },
    })),
  ];

  const selected = (processor as unknown as {
    selectReconciliationBatch: (values: typeof targets, timestamp: number) => typeof targets;
  }).selectReconciliationBatch(targets, at.getTime());

  assert.equal(selected.length, 30);
  assert.equal(selected.filter(target => target.id.startsWith('healthy-')).length, 10);
});

test('reconciliation persists ownership before reapplying OFF and verifies the result under the locks', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([1, 2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const writes: TargetWrite[] = [];
  const events: Array<Record<string, unknown>> = [];
  let targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'pending',
    offlineError: null, offlineAt: new Date('2026-08-26T12:00:00Z'),
    updatedAt: new Date('2026-08-26T12:00:00Z'),
  };
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: { findFirst: async () => ({ id: 'emergency-1' }) },
    storeEmergencyTarget: {
      findUnique: async () => ({ ...targetState }),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (
        where.updatedAt === targetState.updatedAt ? { ...targetState } : null
      ),
      updateMany: async ({ where, data }: TargetWrite) => {
        if (where.updatedAt !== targetState.updatedAt) return { count: 0 };
        writes.push({ where, data });
        targetState = { ...targetState, ...data } as typeof targetState;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; },
    },
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);
  const internal = processor as unknown as {
    claimReconcileLease: (emergencyId: string, brandId: string, targetId: string) => Promise<Record<string, unknown>>;
    executeReconcileWrite: (lease: Record<string, unknown>, token: string, appShopId: string) => Promise<string>;
  };

  const lease = await internal.claimReconcileLease('emergency-1', 'brand-1', 'target-1');
  assert.equal(writes[0].data.restoreStatus, 'required');
  assert.equal('offlineStatus' in writes[0].data, false);
  const result = await internal.executeReconcileWrite(lease, 'token', 'app-shop-1');

  assert.equal(result, 'reapplied');
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 2);
  assert.equal(writes.at(-1)?.data.offlineStatus, 'done');
  assert.equal(writes.at(-1)?.data.restoreStatus, 'pending');
  assert.equal(events.at(-1)?.type, 'target_reconcile_succeeded');
});

test('offline preflight is rechecked under the locks before reconciliation decides no POST is needed', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2, 1, 1, 2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  let targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'pending',
    offlineError: null, offlineAt: new Date('2026-08-26T12:00:00Z'),
    updatedAt: new Date('2026-08-26T12:00:00Z'),
  };
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: { findFirst: async () => ({ id: 'emergency-1' }) },
    storeEmergencyTarget: {
      findUnique: async () => ({ ...targetState }),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (
        where.updatedAt === targetState.updatedAt ? { ...targetState } : null
      ),
      updateMany: async ({ where, data }: TargetWrite) => {
        if (where.updatedAt !== targetState.updatedAt) return { count: 0 };
        targetState = { ...targetState, ...data } as typeof targetState;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: { create: async () => ({}) },
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);
  const targetInput = {
    id: 'target-1', offlineStatus: 'done', restoreStatus: 'pending', offlineError: null,
    updatedAt: targetState.updatedAt, shop: { id: 'shop-1', appShopId: 'app-shop-1' },
  };

  const result = await (processor as unknown as {
    reconcileTarget: (
      emergencyId: string,
      brandId: string,
      target: typeof targetInput,
      appId: string,
      appSecret: string,
    ) => Promise<string>;
  }).reconcileTarget('emergency-1', 'brand-1', targetInput, 'app-1', 'secret');

  assert.equal(result, 'reapplied');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 4);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
});

test('restore claims durable ambiguous ownership even when shutdown did not reach done', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([1]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const fixture = processorFixture();

  await processTarget(fixture.processor, 'restore', 'required');

  const claim = fixture.writes[0];
  assert.deepEqual(claim.where.OR, [
    { restoreStatus: 'required' },
    { offlineStatus: 'done', restoreStatus: 'pending' },
  ]);
  assert.equal('offlineStatus' in claim.data, false);
  assert.equal(claim.data.restoreStatus, 'running');
  assert.equal(remote.calls.some(call => call.url.includes('/setStatus')), false);
});

test('restore finalization resolves a durable ambiguous closure after remote verification', async () => {
  let parentUpdate: Record<string, unknown> | undefined;
  let finalEvent: Record<string, unknown> | undefined;
  const tx = {
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        parentUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { finalEvent = data; return data; },
    },
  };
  const processor = new StoreEmergencyProcessor({
    storeEmergency: { findUnique: async () => ({ id: 'emergency-1', status: 'restoring', restoredAt: null }) },
    storeEmergencyTarget: {
      groupBy: async () => [{ offlineStatus: 'failed', restoreStatus: 'done', _count: { _all: 1 } }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);

  await (processor as unknown as {
    finalize: (id: string, action: string, job: Record<string, unknown>, attempt: number) => Promise<void>;
  }).finalize('emergency-1', 'restore', {
    id: 'job-1', data: { emergencyId: 'emergency-1', action: 'restore', source: 'system' },
  }, 1);

  assert.equal(parentUpdate?.status, 'restored');
  const metadata = finalEvent?.metadata as Record<string, unknown>;
  assert.equal(metadata.restoreRequired, 1);
  assert.equal(metadata.restored, 1);
});

test('watchdog recovery is idempotent across consecutive scheduler runs', async () => {
  const staleAt = new Date('2026-08-26T12:00:00.000Z');
  let recoveryQueued = false;
  let resetCalls = 0;
  let queueCalls = 0;
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findUnique: async () => ({ status: 'running', updatedAt: staleAt, finishedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    storeEmergencyTarget: {
      updateMany: async () => { resetCalls += 1; return { count: 1 }; },
      findFirst: async () => null,
    },
    storeEmergencyEvent: {
      findFirst: async () => recoveryQueued ? { id: 'recovery-event' } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.type === 'recovery_queued') recoveryQueued = true;
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1',
        status: 'running',
        updatedAt: staleAt,
        shutdownQueuedAt: null,
        restoreQueuedAt: null,
        events: recoveryQueued ? [{ id: 'recovery-event' }] : [],
      }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const scheduler = new StoreEmergencyScheduler(prisma as never, {
    add: async () => {
      queueCalls += 1;
      return { id: 'recovery-job', timestamp: staleAt.getTime() };
    },
  } as never);

  await scheduler.recoverStaleTransitions();
  await scheduler.recoverStaleTransitions();

  assert.equal(queueCalls, 1);
  assert.equal(resetCalls, 1);
});
