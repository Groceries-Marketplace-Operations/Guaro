import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StoreEmergencyProcessor } from '../src/integrations/store-emergency.processor';
import { StoreEmergencyScheduler } from '../src/integrations/store-emergency.scheduler';

type TargetWrite = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

type SetStatusReply = 'match' | 'missing' | 'mismatch';

function didiFetch(
  detailStatuses: Array<number | { errno: number; errmsg?: string }>,
  setStatusReplies: SetStatusReply[] = [],
) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }), { status: 200 });
    }
    if (url.includes('/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'token' } }), { status: 200 });
    }
    if (url.includes('/shop/shop/detail')) {
      const detail = detailStatuses.shift();
      assert.notEqual(detail, undefined, 'test must provide every expected readback');
      return typeof detail === 'number'
        ? new Response(JSON.stringify({ errno: 0, data: { biz_status: detail } }), { status: 200 })
        : new Response(JSON.stringify(detail), { status: 200 });
    }
    if (url.includes('/shop/shop/setStatus')) {
      const requested = Number(body?.biz_status);
      const reply = setStatusReplies.shift() ?? 'match';
      const data = reply === 'missing'
        ? {}
        : { biz_status: reply === 'match' ? requested === 1 : requested !== 1 };
      return new Response(JSON.stringify({ errno: 0, data }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

function processorFixture(
  openingPermit?: (options: Record<string, unknown>) => Promise<unknown>,
  observeWrite?: (write: TargetWrite) => void,
) {
  const writes: TargetWrite[] = [];
  const events: Array<Record<string, unknown>> = [];
  const updateMany = async ({ where, data }: TargetWrite) => {
    observeWrite?.({ where, data });
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

type SlotReservation = Record<string, unknown> & {
  emergencyId: string;
  targetId: string;
  type: string;
  occurredAt: Date;
  metadata: { applicationId: string; cooldownMs: number };
};

function reconcileSlotHarness(input: {
  peerIds: string[];
  reservations?: SlotReservation[];
  holdApplicationLaneFor?: string;
}) {
  const updatedAt = new Date('2026-08-26T12:00:00Z');
  const reservations = input.reservations ?? [];
  const targetWrites: TargetWrite[] = [];
  const allEvents: Array<Record<string, unknown>> = [];
  const targets = new Map(input.peerIds.map((emergencyId, index) => [
    `target-${index + 1}`,
    {
      emergencyId,
      offlineStatus: 'done',
      restoreStatus: 'pending',
      offlineError: null as string | null,
      restoreError: null as string | null,
      offlineAt: updatedAt,
      updatedAt,
    },
  ]));
  const laneEvents: string[] = [];
  const laneWaiters = new Map<string, () => void>();
  const signalLaneEvent = (event: string) => {
    laneEvents.push(event);
    laneWaiters.get(event)?.();
    laneWaiters.delete(event);
  };
  const waitUntilLaneEvent = (event: string) => laneEvents.includes(event)
    ? Promise.resolve()
    : new Promise<void>(resolve => { laneWaiters.set(event, resolve); });
  let releaseHeldLane!: () => void;
  const heldLane = new Promise<void>(resolve => { releaseHeldLane = resolve; });
  let applicationLane = Promise.resolve();
  const acquireApplicationLane = async (targetId: string) => {
    const previous = applicationLane;
    let release!: () => void;
    applicationLane = new Promise<void>(resolve => { release = resolve; });
    signalLaneEvent(`${targetId}:waiting`);
    await previous;
    signalLaneEvent(`${targetId}:acquired`);
    if (input.holdApplicationLaneFor === targetId) await heldLane;
    return release;
  };
  const createTx = () => {
    let transactionTargetId = 'unknown-target';
    let releaseApplicationLane: (() => void) | undefined;
    const tx = {
      $executeRaw: async (query: unknown) => {
        const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(' ');
        if (sql.includes(', 2')) {
          releaseApplicationLane = await acquireApplicationLane(transactionTargetId);
        }
        return 1;
      },
      storeEmergency: {
        findFirst: async () => ({ id: 'live-emergency' }),
        findMany: async () => input.peerIds.map(id => ({ id })),
      },
      storeEmergencyTarget: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          transactionTargetId = where.id;
          return targets.get(where.id) ?? null;
        },
        updateMany: async ({ where, data }: TargetWrite) => {
          targetWrites.push({ where, data });
          const current = targets.get(String(where.id));
          if (!current) return { count: 0 };
          targets.set(String(where.id), { ...current, ...data } as typeof current);
          return { count: 1 };
        },
      },
      storeEmergencyEvent: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const cutoff = (where.occurredAt as { gt: Date }).gt;
          const applicationId = (where.metadata as { equals: string }).equals;
          const latest = reservations
            .filter(event => event.metadata.applicationId === applicationId && event.occurredAt > cutoff)
            .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0];
          return latest ? { id: String(latest.id ?? 'reservation') } : null;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          const peerIds = (where.emergencyId as { in: string[] }).in;
          const applicationId = (where.metadata as { equals: string }).equals;
          const latestByEmergency = new Map<string, SlotReservation>();
          for (const event of [...reservations].sort(
            (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
          )) {
            if (
              peerIds.includes(event.emergencyId)
              && event.metadata.applicationId === applicationId
              && !latestByEmergency.has(event.emergencyId)
            ) latestByEmergency.set(event.emergencyId, event);
          }
          return [...latestByEmergency.values()].map(event => ({
            emergencyId: event.emergencyId,
            occurredAt: event.occurredAt,
          }));
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          allEvents.push(data);
          if (data.type === 'reconcile_detail_read_reserved') {
            reservations.push({
              ...data,
              id: `reservation-${reservations.length + 1}`,
            } as unknown as SlotReservation);
          }
          return data;
        },
      },
    };
    return {
      tx,
      release: () => {
        if (!releaseApplicationLane) return;
        signalLaneEvent(`${transactionTargetId}:released`);
        releaseApplicationLane();
      },
    };
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (
      callback: (client: ReturnType<typeof createTx>['tx']) => Promise<unknown>,
    ) => {
      const transaction = createTx();
      try {
        return await callback(transaction.tx);
      } finally {
        transaction.release();
      }
    },
  } as never, {} as never, {} as never);
  const reconcile = (emergencyId: string, brandId: string, targetId: string) => {
    const target = {
      id: targetId, offlineStatus: 'done', restoreStatus: 'pending', offlineError: null,
      updatedAt, shop: { id: `shop-${targetId}`, appShopId: `app-shop-${targetId}` },
      events: reservations
        .filter(event => event.targetId === targetId)
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(0, 1)
        .map(event => ({ occurredAt: event.occurredAt })),
    };
    return (processor as unknown as {
      reconcileTarget: (
        emergency: string,
        brand: string,
        value: typeof target,
        applicationId: string,
        appId: string,
        appSecret: string,
      ) => Promise<string>;
    }).reconcileTarget(emergencyId, brandId, target, 'shared-application', 'app-1', 'secret');
  };
  return {
    allEvents,
    laneEvents,
    processor,
    reconcile,
    releaseHeldLane,
    reservations,
    targetWrites,
    targets,
    waitUntilLaneEvent,
  };
}

test('critical shutdown uses no detail and commits durable ownership before confirmed OFF', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
  const order: string[] = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/shop/shop/setStatus')) order.push('post');
    return remote.fetcher(input, init);
  }) as typeof fetch;
  const fixture = processorFixture(
    async () => assert.fail('restore permit must not be used for shutdown'),
    write => {
      if (write.data.restoreStatus === 'required') order.push('ownership');
      if (write.data.offlineStatus === 'done') order.push('done');
    },
  );

  await processTarget(fixture.processor, 'offline', 'pending');

  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(remote.calls.find(call => call.url.includes('/setStatus'))?.body?.biz_status, 2);
  assert.ok(order.indexOf('ownership') >= 0 && order.indexOf('ownership') < order.indexOf('post'));
  assert.ok(order.indexOf('done') > order.indexOf('post'));
  const completed = fixture.writes.find(write => write.data.offlineStatus === 'done');
  assert.equal(completed?.data.restoreStatus, 'pending');
  assert.equal(fixture.events.at(-1)?.type, 'target_shutdown_succeeded');
  const metadata = fixture.events.at(-1)?.metadata as Record<string, unknown>;
  assert.equal(metadata.providerWriteAttempted, true);
  assert.equal(metadata.verificationSource, 'setStatus_response');
  assert.equal(metadata.providerBizStatus, 2);
});

test('missing or mismatched OFF confirmation never completes and preserves required ownership', async t => {
  for (const reply of ['missing', 'mismatch'] as const) {
    await t.test(reply, async () => {
      const originalFetch = globalThis.fetch;
      const remote = didiFetch([], [reply]);
      globalThis.fetch = remote.fetcher;
      try {
        const fixture = processorFixture();

        await processTarget(fixture.processor, 'offline', 'pending');

        const ownershipIndex = fixture.writes.findIndex(write => write.data.restoreStatus === 'required');
        const failureIndex = fixture.writes.findIndex(write => write.data.offlineStatus === 'failed');
        assert.ok(ownershipIndex >= 0 && failureIndex > ownershipIndex);
        assert.equal(fixture.writes.some(write => write.data.offlineStatus === 'done'), false);
        assert.equal(
          fixture.writes.slice(ownershipIndex + 1).some(write => 'restoreStatus' in write.data),
          false,
        );
        assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
        assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
        assert.equal(fixture.events.at(-1)?.type, 'target_shutdown_failed');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test('critical restore uses no detail and validates its exact lease before confirmed ONLINE', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
  const order: string[] = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/shop/shop/setStatus')) order.push('post');
    return remote.fetcher(input, init);
  }) as typeof fetch;
  let permit: Record<string, unknown> | undefined;
  let validateWrite: TargetWrite | undefined;
  let writesDuringExecute = -1;
  let fixture: ReturnType<typeof processorFixture>;
  fixture = processorFixture(
    async options => {
      permit = options;
      await (options.validate as (tx: Record<string, unknown>) => Promise<void>)({
        storeEmergencyTarget: {
          updateMany: async (input: TargetWrite) => {
            order.push('lease_validation');
            validateWrite = input;
            return { count: 1 };
          },
        },
      });
      const before = fixture.writes.length;
      const result = await (options.execute as () => Promise<unknown>)();
      writesDuringExecute = fixture.writes.length - before;
      return result;
    },
    write => {
      if (write.data.restoreStatus === 'running') order.push('ownership');
    },
  );

  await processTarget(fixture.processor, 'restore', 'pending');

  assert.equal(permit?.shopId, 'shop-1');
  assert.equal(permit?.allowedEmergencyId, 'emergency-1');
  assert.equal(validateWrite?.where.restoreStatus, 'running');
  assert.equal(validateWrite?.where.updatedAt, validateWrite?.data.updatedAt);
  assert.deepEqual(validateWrite?.where.emergency, {
    id: 'emergency-1', status: 'restoring', finishedAt: null,
  });
  assert.equal(writesDuringExecute, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(remote.calls.find(call => call.url.includes('/setStatus'))?.body?.biz_status, 1);
  assert.ok(order.indexOf('ownership') >= 0 && order.indexOf('ownership') < order.indexOf('post'));
  assert.ok(order.indexOf('lease_validation') >= 0 && order.indexOf('lease_validation') < order.indexOf('post'));
  assert.equal(fixture.writes.some(write => write.data.restoreStatus === 'done'), true);
  const metadata = fixture.events.at(-1)?.metadata as Record<string, unknown>;
  assert.equal(metadata.verificationSource, 'setStatus_response');
  assert.equal(metadata.providerBizStatus, 1);
});

test('emergency restore never sends POST after the exact lease validation is lost', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const fixture = processorFixture(async options => {
    await (options.validate as (tx: Record<string, unknown>) => Promise<void>)({
      storeEmergencyTarget: { updateMany: async () => ({ count: 0 }) },
    });
    return (options.execute as () => Promise<unknown>)();
  });

  await processTarget(fixture.processor, 'restore', 'pending');

  assert.equal(remote.calls.some(call => call.url.includes('/setStatus')), false);
  assert.equal(remote.calls.some(call => call.url.includes('/shop/shop/detail')), false);
  assert.equal(fixture.events.some(event => event.type === 'target_restore_failed'), false);
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

test('reconciliation selects at most one target and rotates after a durable reservation', () => {
  const processor = new StoreEmergencyProcessor({} as never, {} as never, {} as never);
  const at = new Date(Math.floor(new Date('2026-08-26T12:00:00Z').getTime() / 600_000) * 600_000);
  const targets = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `urgent-${index}`,
      offlineStatus: 'failed',
      restoreStatus: 'required',
      offlineError: 'still online',
      updatedAt: at,
      shop: { id: `urgent-shop-${index}`, appShopId: `urgent-app-${index}` },
      events: [] as Array<{ occurredAt: Date }>,
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `healthy-${index}`,
      offlineStatus: 'done',
      restoreStatus: 'pending',
      offlineError: null,
      updatedAt: at,
      shop: { id: `healthy-shop-${index}`, appShopId: `healthy-app-${index}` },
      events: [] as Array<{ occurredAt: Date }>,
    })),
  ];

  const selected = (processor as unknown as {
    selectReconciliationBatch: (values: typeof targets, timestamp: number) => typeof targets;
  }).selectReconciliationBatch(targets, at.getTime());
  selected[0].events = [{ occurredAt: at }];
  const selectedNextMinute = (processor as unknown as {
    selectReconciliationBatch: (values: typeof targets, timestamp: number) => typeof targets;
  }).selectReconciliationBatch(targets, at.getTime() + 60_000);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id.startsWith('urgent-'), true);
  assert.equal(selectedNextMinute.length, 1);
  assert.equal(selectedNextMinute[0].id.startsWith('healthy-'), true);
});

test('healthy sampling follows reservation age when every effective slot is an odd minute', () => {
  const processor = new StoreEmergencyProcessor({} as never, {} as never, {} as never);
  const minute = 60_000;
  const base = new Date('2026-08-26T12:00:00Z').getTime();
  const firstOddMinute = Math.floor(base / minute) % 2 === 1 ? base : base + minute;
  const updatedAt = new Date(firstOddMinute - 60 * minute);
  const targets = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `urgent-${String(index).padStart(2, '0')}`,
      offlineStatus: 'failed',
      restoreStatus: 'required',
      offlineError: 'still online',
      updatedAt,
      shop: { id: `urgent-shop-${index}`, appShopId: `urgent-app-${index}` },
      events: [] as Array<{ occurredAt: Date }>,
    })),
    {
      id: 'healthy-00',
      offlineStatus: 'done',
      restoreStatus: 'pending',
      offlineError: null,
      updatedAt,
      shop: { id: 'healthy-shop-0', appShopId: 'healthy-app-0' },
      events: [] as Array<{ occurredAt: Date }>,
    },
  ];
  const select = (timestamp: number) => (processor as unknown as {
    selectReconciliationBatch: (values: typeof targets, at: number) => typeof targets;
  }).selectReconciliationBatch(targets, timestamp);
  const reserve = (timestamp: number) => {
    assert.equal(Math.floor(timestamp / minute) % 2, 1, 'every effective slot must be an odd minute');
    const [selected] = select(timestamp);
    assert.ok(selected);
    selected.events = [{ occurredAt: new Date(timestamp) }];
    return selected.id;
  };

  assert.equal(reserve(firstOddMinute).startsWith('urgent-'), true);
  assert.equal(reserve(firstOddMinute + 2 * minute), 'healthy-00');
  for (const offset of [4, 6, 8, 10]) {
    assert.equal(reserve(firstOddMinute + offset * minute).startsWith('urgent-'), true);
  }

  // The healthy target was last reserved 12 minutes ago. Selection must use
  // that durable age even though the minute parity never changes.
  assert.equal(reserve(firstOddMinute + 14 * minute), 'healthy-00');
});

test('least-recently-reserved selection serves all 30 urgent targets before repeating one', () => {
  const processor = new StoreEmergencyProcessor({} as never, {} as never, {} as never);
  const startedAt = new Date('2026-08-26T12:00:00Z').getTime();
  const updatedAt = new Date('2026-08-26T11:00:00Z');
  const targets = Array.from({ length: 30 }, (_, index) => ({
    id: `urgent-${String(index).padStart(2, '0')}`,
    offlineStatus: 'failed',
    restoreStatus: 'required',
    offlineError: 'still online',
    updatedAt,
    shop: { id: `shop-${index}`, appShopId: `app-shop-${index}` },
    events: [] as Array<{ occurredAt: Date }>,
  }));
  const select = (timestamp: number) => (processor as unknown as {
    selectReconciliationBatch: (values: typeof targets, at: number) => typeof targets;
  }).selectReconciliationBatch(targets, timestamp);
  const served: string[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const effectiveSlotAt = startedAt + index * 120_000;
    const [selected] = select(effectiveSlotAt);
    assert.ok(selected, `slot ${index + 1} must select one urgent target`);
    served.push(selected.id);
    selected.events = [{ occurredAt: new Date(effectiveSlotAt) }];
  }

  assert.equal(new Set(served).size, 30);
  assert.deepEqual(served, targets.map(target => target.id));
  const [firstRepeat] = select(startedAt + targets.length * 120_000);
  assert.equal(firstRepeat.id, served[0]);
});

test('online reconciliation owns before POST and completes in one cycle from matching false', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([1]);
  const order: string[] = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/shop/shop/detail')) order.push('detail');
    if (url.includes('/shop/shop/setStatus')) order.push('post');
    return remote.fetcher(input, init);
  }) as typeof fetch;
  const writes: TargetWrite[] = [];
  const events: Array<Record<string, unknown>> = [];
  let targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'pending',
    offlineError: null as string | null, restoreError: null as string | null,
    offlineAt: new Date('2026-08-26T12:00:00Z'),
    updatedAt: new Date('2026-08-26T12:00:00Z'),
  };
  const tx = {
    $executeRaw: async () => { order.push('lock'); return 1; },
    storeEmergency: {
      findFirst: async () => ({ id: 'emergency-1' }),
      findMany: async () => [{ id: 'emergency-1' }],
    },
    storeEmergencyTarget: {
      findUnique: async () => ({ ...targetState }),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (
        where.updatedAt === targetState.updatedAt ? { ...targetState } : null
      ),
      updateMany: async ({ where, data }: TargetWrite) => {
        if (where.updatedAt !== targetState.updatedAt) return { count: 0 };
        if (data.restoreStatus === 'required' && data.offlineAttempts) order.push('ownership');
        writes.push({ where, data });
        targetState = { ...targetState, ...data } as typeof targetState;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; },
    },
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      order.push('commit');
      return result;
    },
  } as never, {} as never, {} as never);
  const targetInput = {
    id: 'target-1', offlineStatus: 'done', restoreStatus: 'pending', offlineError: null,
    updatedAt: targetState.updatedAt, shop: { id: 'shop-1', appShopId: 'app-shop-1' },
    events: [] as Array<{ occurredAt: Date }>,
  };

  const result = await (processor as unknown as {
    reconcileTarget: (
      emergencyId: string,
      brandId: string,
      target: typeof targetInput,
      applicationId: string,
      appId: string,
      appSecret: string,
    ) => Promise<string>;
  }).reconcileTarget('emergency-1', 'brand-1', targetInput, 'application-1', 'app-1', 'secret');

  assert.equal(result, 'reapplied');
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);
  assert.ok(order.indexOf('detail') > order.indexOf('lock'));
  assert.ok(order.indexOf('ownership') > order.indexOf('detail'));
  const ownershipCommit = order.findIndex((entry, index) => (
    entry === 'commit' && index > order.indexOf('ownership')
  ));
  assert.ok(ownershipCommit > order.indexOf('ownership'));
  assert.ok(order.indexOf('post') > ownershipCommit);
  assert.equal(writes[0].data.restoreStatus, 'required');
  assert.equal('offlineStatus' in writes[0].data, false);
  assert.equal('offlineError' in writes[0].data, false);
  assert.equal(writes[1].data.offlineStatus, 'done');
  assert.equal(writes[1].data.restoreStatus, 'pending');
  assert.equal(targetState.offlineStatus, 'done');
  assert.equal(targetState.offlineError, null);
  assert.equal(targetState.restoreStatus, 'pending');
  assert.equal(events.at(-1)?.type, 'target_reconcile_succeeded');
  const metadata = events.at(-1)?.metadata as Record<string, unknown>;
  assert.equal(metadata.remoteVerified, true);
  assert.equal(metadata.verificationSource, 'setStatus_response');
  assert.equal(metadata.providerBizStatus, 2);
  assert.equal(
    events.find(event => event.type === 'reconcile_detail_read_reserved')?.targetId,
    'target-1',
  );
});

test('the next reconciliation tick confirms an owned OFF result with one detail and no duplicate POST', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const events: Array<Record<string, unknown>> = [];
  let targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'required',
    offlineError: 'OFF request pending remote verification' as string | null,
    restoreError: null as string | null, offlineAt: new Date('2026-08-26T12:00:00Z'),
    updatedAt: new Date('2026-08-26T12:00:00Z'),
  };
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findFirst: async () => ({ id: 'emergency-1' }),
      findMany: async () => [{ id: 'emergency-1' }],
    },
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
    storeEmergencyEvent: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; },
    },
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);
  const targetInput = {
    id: 'target-1', offlineStatus: 'done', restoreStatus: 'required',
    offlineError: 'OFF request pending remote verification',
    updatedAt: targetState.updatedAt, shop: { id: 'shop-1', appShopId: 'app-shop-1' },
    events: [{ occurredAt: targetState.updatedAt }],
  };

  const result = await (processor as unknown as {
    reconcileTarget: (
      emergencyId: string,
      brandId: string,
      target: typeof targetInput,
      applicationId: string,
      appId: string,
      appSecret: string,
    ) => Promise<string>;
  }).reconcileTarget('emergency-1', 'brand-1', targetInput, 'application-1', 'app-1', 'secret');

  assert.equal(result, 'already_offline');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.equal(targetState.offlineError, null);
  assert.equal(targetState.restoreStatus, 'pending');
  assert.equal(events.at(-1)?.type, 'target_reconcile_succeeded');
  assert.equal((events.at(-1)?.metadata as Record<string, unknown>).remoteVerified, true);
});

test('detail errno=10005 defers without degrading or writing an error on a healthy target', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([{ errno: 10005, errmsg: 'window60 limit1' }]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const updatedAt = new Date('2026-08-26T12:00:00Z');
  const targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'pending',
    offlineError: null, restoreError: null, offlineAt: updatedAt, updatedAt,
  };
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findFirst: async () => ({ id: 'emergency-1' }),
      findMany: async () => [{ id: 'emergency-1' }],
    },
    storeEmergencyTarget: {
      findUnique: async () => ({ ...targetState }),
      updateMany: async () => assert.fail('rate-limited detail must not mutate the target'),
    },
    storeEmergencyEvent: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; },
    },
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never, {} as never, {} as never);
  const targetInput = {
    id: 'target-1', offlineStatus: 'done', restoreStatus: 'pending', offlineError: null,
    updatedAt, shop: { id: 'shop-1', appShopId: 'app-shop-1' },
    events: [] as Array<{ occurredAt: Date }>,
  };

  const result = await (processor as unknown as {
    reconcileTarget: (
      emergencyId: string,
      brandId: string,
      target: typeof targetInput,
      applicationId: string,
      appId: string,
      appSecret: string,
    ) => Promise<string>;
  }).reconcileTarget('emergency-1', 'brand-1', targetInput, 'application-1', 'app-1', 'secret');

  assert.equal(result, 'skipped');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.equal(targetState.offlineStatus, 'done');
  assert.equal(targetState.restoreStatus, 'pending');
  assert.equal(targetState.offlineError, null);
  assert.deepEqual(events.map(event => event.type), ['reconcile_detail_read_reserved']);
  assert.equal(events[0].targetId, 'target-1');
});

test('a durable reservation survives a crashed inspection and blocks a new instance for 65 seconds', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const persistedReservations: SlotReservation[] = [];
  const crashedInstance = reconcileSlotHarness({
    peerIds: ['emergency-1'],
    reservations: persistedReservations,
  });
  const reserved = await (crashedInstance.processor as unknown as {
    claimReconcileDetailSlot: (
      emergencyId: string,
      brandId: string,
      targetId: string,
      applicationId: string,
    ) => Promise<boolean>;
  }).claimReconcileDetailSlot('emergency-1', 'brand-1', 'target-1', 'shared-application');
  assert.equal(reserved, true);
  assert.equal(persistedReservations.length, 1);
  assert.equal(persistedReservations[0].targetId, 'target-1');

  // The process crashes before its inspection transaction starts. A fresh
  // processor sees the committed reservation and must not consume detail.
  const freshInstance = reconcileSlotHarness({
    peerIds: ['emergency-1', 'emergency-2'],
    reservations: persistedReservations,
  });
  const second = await freshInstance.reconcile('emergency-2', 'brand-2', 'target-2');

  assert.equal(second, 'skipped');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.equal(persistedReservations.length, 1);
  assert.deepEqual(persistedReservations[0].metadata, {
    applicationId: 'shared-application', cooldownMs: 65_000,
  });
});

test('a fair-turn peer waits for a non-selected holder and reserves after its commit in the same tick', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const oldReservation = {
    id: 'old-reservation',
    emergencyId: 'emergency-1',
    targetId: 'target-1',
    type: 'reconcile_detail_read_reserved',
    occurredAt: new Date(Date.now() - 120_000),
    metadata: { applicationId: 'shared-application', cooldownMs: 65_000 },
  } as SlotReservation;
  const harness = reconcileSlotHarness({
    peerIds: ['emergency-1', 'emergency-2'],
    reservations: [oldReservation],
    holdApplicationLaneFor: 'target-1',
  });

  const first = harness.reconcile('emergency-1', 'brand-1', 'target-1');
  await harness.waitUntilLaneEvent('target-1:acquired');
  const secondWaiting = harness.waitUntilLaneEvent('target-2:waiting');
  const second = harness.reconcile('emergency-2', 'brand-2', 'target-2');
  await secondWaiting;
  assert.equal(harness.laneEvents.includes('target-2:acquired'), false);
  harness.releaseHeldLane();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, 'skipped');
  assert.equal(secondResult, 'already_offline');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.equal(harness.targetWrites.length, 0);
  assert.deepEqual(
    harness.reservations.map(event => [event.emergencyId, event.targetId]),
    [
      ['emergency-1', 'target-1'],
      ['emergency-2', 'target-2'],
    ],
  );
  assert.ok(
    harness.laneEvents.indexOf('target-2:waiting')
      < harness.laneEvents.indexOf('target-1:released'),
  );
  assert.ok(
    harness.laneEvents.indexOf('target-1:released')
      < harness.laneEvents.indexOf('target-2:acquired'),
  );
  assert.equal(harness.allEvents.some(event => event.type === 'target_reconcile_failed'), false);
});

test('same-application emergencies receive the detail slot in fair turns after 65 seconds', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2, 2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const harness = reconcileSlotHarness({ peerIds: ['emergency-1', 'emergency-2'] });

  const first = await harness.reconcile('emergency-1', 'brand-1', 'target-1');
  const blocked = await harness.reconcile('emergency-2', 'brand-2', 'target-2');
  assert.equal(first, 'already_offline');
  assert.equal(blocked, 'skipped');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);

  harness.reservations[0].occurredAt = new Date(Date.now() - 66_000);
  const second = await harness.reconcile('emergency-2', 'brand-2', 'target-2');

  assert.equal(second, 'already_offline');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 2);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.deepEqual(
    harness.reservations.map(event => event.emergencyId),
    ['emergency-1', 'emergency-2'],
  );
  assert.deepEqual(
    harness.reservations.map(event => event.targetId),
    ['target-1', 'target-2'],
  );
});

test('an auth failure after A reserves does not starve B after the 65-second turn', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([2]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/authtoken/refresh') && url.includes('app_shop_id=app-shop-target-1')) {
      return new Response(JSON.stringify({ errno: 10003, errmsg: 'simulated auth failure' }), { status: 200 });
    }
    return remote.fetcher(input, init);
  }) as typeof fetch;
  const harness = reconcileSlotHarness({ peerIds: ['emergency-1', 'emergency-2'] });

  const first = await harness.reconcile('emergency-1', 'brand-1', 'target-1');
  assert.equal(first, 'failed');
  assert.equal(harness.reservations.length, 1);
  assert.equal(harness.reservations[0].targetId, 'target-1');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);

  harness.reservations[0].occurredAt = new Date(Date.now() - 66_000);
  const second = await harness.reconcile('emergency-2', 'brand-2', 'target-2');

  assert.equal(second, 'already_offline');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 1);
  assert.deepEqual(
    harness.reservations.map(event => [event.emergencyId, event.targetId]),
    [
      ['emergency-1', 'target-1'],
      ['emergency-2', 'target-2'],
    ],
  );
});

test('a recent pending verification performs no auth, detail, or POST inside the cooldown', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = remote.fetcher;
  const updatedAt = new Date();
  const targetState = {
    emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'required',
    offlineError: 'OFF request pending remote verification', restoreError: null,
    offlineAt: new Date('2026-08-26T12:00:00Z'), updatedAt,
  };
  const processor = new StoreEmergencyProcessor({
    $transaction: async () => assert.fail('recent pending verification must return before a transaction'),
  } as never, {} as never, {} as never);
  const targetInput = {
    id: 'target-1', offlineStatus: 'done', restoreStatus: 'required',
    offlineError: targetState.offlineError, updatedAt,
    shop: { id: 'shop-1', appShopId: 'app-shop-1' },
    events: [{ occurredAt: updatedAt }],
  };

  const result = await (processor as unknown as {
    reconcileTarget: (
      emergencyId: string,
      brandId: string,
      target: typeof targetInput,
      applicationId: string,
      appId: string,
      appSecret: string,
    ) => Promise<string>;
  }).reconcileTarget('emergency-1', 'brand-1', targetInput, 'application-1', 'app-1', 'secret');

  assert.equal(result, 'skipped');
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 0);
  assert.equal(remote.calls.length, 0);
});

test('restore processes durable ambiguous ownership even when shutdown did not reach done', async t => {
  const originalFetch = globalThis.fetch;
  const remote = didiFetch([]);
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
  assert.equal(remote.calls.filter(call => call.url.includes('/shop/shop/detail')).length, 0);
  assert.equal(remote.calls.filter(call => call.url.includes('/setStatus')).length, 1);
  assert.equal(fixture.writes.some(write => write.data.restoreStatus === 'done'), true);
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
