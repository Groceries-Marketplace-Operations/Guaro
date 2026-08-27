import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { StoreEmergencyService } from '../src/integrations/store-emergency.service';
import { StoreEmergencyProcessor } from '../src/integrations/store-emergency.processor';
import { StoreEmergencyScheduler } from '../src/integrations/store-emergency.scheduler';
import { sanitizeEmergencyMessage } from '../src/integrations/store-emergency-events';
import { StoreOpeningGuardService } from '../src/integrations/store-opening-guard.service';
import {
  isEmergencyConflict,
  STORE_EMERGENCY_CONFLICT_CODE,
  STORE_EMERGENCY_LIVE_STATUSES,
  storeEmergencyLiveWhere,
} from '../src/integrations/store-emergency-status';

const date = new Date('2026-08-19T12:00:00.000Z');

function emergency(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emergency-1',
    brandId: 'brand-1',
    mode: 'all_brand',
    requestedIds: [],
    reason: 'Operational incident',
    endsAt: new Date('2026-08-20T12:00:00.000Z'),
    status: 'offline',
    createdById: 'actor-1',
    shutdownQueuedAt: date,
    startedAt: date,
    shutdownFinishedAt: date,
    offlineAt: date,
    restoreRequestedAt: null,
    restoreQueuedAt: null,
    restoreStartedAt: null,
    restoreFinishedAt: null,
    restoredAt: null,
    finishedAt: null,
    errorMessage: null,
    createdAt: date,
    updatedAt: date,
    brand: { id: 'brand-1', brandId: 'B1', brandName: 'Brand', country: 'MX' },
    createdBy: { id: 'actor-1', name: 'Admin', email: 'admin@example.com' },
    ...overrides,
  };
}

test('compact emergency list omits targets and returns grouped target counts', async () => {
  const row = emergency({
    _count: { targets: 3 },
    errorMessage: '{"Authorization":"Bearer historical-secret"}',
  });
  const prisma = {
    storeEmergency: {
      findMany: async () => [row],
      count: async () => 1,
    },
    storeEmergencyTarget: {
      groupBy: async () => [
        { emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'pending', _count: { _all: 2 } },
        { emergencyId: 'emergency-1', offlineStatus: 'failed', restoreStatus: 'pending', _count: { _all: 1 } },
      ],
    },
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);

  const result = await service.list(1, 20, true);

  assert.equal('targets' in result.data[0], false);
  assert.deepEqual(result.data[0].targetCounts, {
    total: 3,
    shutdownSucceeded: 2,
    shutdownFailed: 1,
    shutdownPending: 0,
    restoreSucceeded: 0,
    restoreFailed: 0,
    restorePending: 2,
    restoreRequired: 0,
    restoreNotRequired: 0,
  });
  assert.doesNotMatch(String(result.data[0].errorMessage), /historical-secret/);
});

test('legacy emergency list keeps targets during rolling frontend deployments', async () => {
  const targets = [
    { offlineStatus: 'done', restoreStatus: 'pending' },
    { offlineStatus: 'failed', restoreStatus: 'pending' },
  ];
  const prisma = {
    storeEmergency: {
      findMany: async () => [emergency({ targets })],
      count: async () => 1,
    },
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);

  const result = await service.list(1, 20, false);

  const legacyTargets = (result.data[0] as unknown as { targets: typeof targets }).targets;
  assert.equal(legacyTargets.length, targets.length);
  assert.deepEqual(legacyTargets.map(target => target.offlineStatus), ['done', 'failed']);
  assert.equal(result.data[0].targetCounts.restorePending, 1);
});

test('target counts distinguish restoration ownership from stores that must remain untouched', async () => {
  const row = emergency({ _count: { targets: 4 } });
  const prisma = {
    storeEmergency: { findMany: async () => [row], count: async () => 1 },
    storeEmergencyTarget: {
      groupBy: async () => [
        { emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'required', _count: { _all: 2 } },
        { emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'not_required', _count: { _all: 1 } },
        { emergencyId: 'emergency-1', offlineStatus: 'done', restoreStatus: 'done', _count: { _all: 1 } },
      ],
    },
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);

  const result = await service.list(1, 20, true);

  assert.equal(result.data[0].targetCounts.restorePending, 2);
  assert.equal(result.data[0].targetCounts.restoreRequired, 2);
  assert.equal(result.data[0].targetCounts.restoreNotRequired, 1);
  assert.equal(result.data[0].targetCounts.restoreSucceeded, 1);
});

test('live emergency predicate excludes terminal and legacy-finished rows by construction', () => {
  assert.deepEqual(storeEmergencyLiveWhere(), {
    status: { in: [...STORE_EMERGENCY_LIVE_STATUSES] },
    finishedAt: null,
  });
  assert.equal(STORE_EMERGENCY_LIVE_STATUSES.includes('partial_restored' as never), false);
  assert.equal(STORE_EMERGENCY_LIVE_STATUSES.includes('restore_failed' as never), false);
});

test('opening permit holds a shared brand lock and returns a structured emergency conflict', async () => {
  let lockCalls = 0;
  let executeCalls = 0;
  let transactionOptions: Record<string, unknown> | undefined;
  let emergencyWhere: Record<string, unknown> | undefined;
  const tx = {
    shop: {
      findUnique: async () => ({ id: 'shop-1', shopId: 'S1', brandId: 'brand-1', deletedAt: null }),
    },
    $executeRaw: async () => { lockCalls += 1; return 1; },
    storeEmergency: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        emergencyWhere = where;
        return {
          id: 'emergency-2', brandId: 'brand-1', mode: 'all_brand', status: 'offline', endsAt: date,
        };
      },
    },
  };
  const prisma = {
    $transaction: async (
      callback: (client: typeof tx) => Promise<unknown>,
      options: Record<string, unknown>,
    ) => {
      transactionOptions = options;
      return callback(tx);
    },
  };
  const guard = new StoreOpeningGuardService(prisma as never);

  let thrown: unknown;
  try {
    await guard.withOpeningPermit({
      shopId: 'shop-1',
      allowedEmergencyId: 'emergency-1',
      operation: 'test_open',
      execute: async () => { executeCalls += 1; },
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(lockCalls, 2);
  assert.equal(executeCalls, 0);
  assert.deepEqual(transactionOptions, { maxWait: 5_000, timeout: 25_000 });
  assert.equal((emergencyWhere?.status as { in: string[] }).in.includes('restore_failed'), false);
  assert.equal(emergencyWhere?.finishedAt, null);
  assert.deepEqual(emergencyWhere?.id, { not: 'emergency-1' });
  assert.equal(isEmergencyConflict(thrown), true);
  assert.equal((thrown as { getResponse: () => { code: string } }).getResponse().code, STORE_EMERGENCY_CONFLICT_CODE);
});

test('opening permit refuses to start a provider write after its pre-write budget expires', async t => {
  const originalNow = Date.now;
  let nowCalls = 0;
  Date.now = () => nowCalls++ === 0 ? 1_000 : 11_001;
  t.after(() => { Date.now = originalNow; });
  let validateCalls = 0;
  let executeCalls = 0;
  const tx = {
    shop: {
      findUnique: async () => ({ id: 'shop-1', shopId: 'S1', brandId: 'brand-1', deletedAt: null }),
    },
    $executeRaw: async () => 1,
    storeEmergency: { findFirst: async () => null },
  };
  const guard = new StoreOpeningGuardService({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never);

  await assert.rejects(guard.withOpeningPermit({
    shopId: 'shop-1',
    operation: 'budget_test',
    validate: async () => { validateCalls += 1; },
    execute: async () => { executeCalls += 1; },
  }), /expired before the provider write/);

  assert.equal(validateCalls, 1);
  assert.equal(executeCalls, 0);
});

test('timeline applies filters, pagination and newest-first deterministic order', async () => {
  let eventQuery: Record<string, unknown> | undefined;
  const prisma = {
    storeEmergency: { findUnique: async () => emergency() },
    storeEmergencyEvent: {
      findMany: async (query: Record<string, unknown>) => {
        eventQuery = query;
        return [{ id: 'event-1', type: 'shutdown_failed' }];
      },
      count: async () => 1,
    },
    storeEmergencyTarget: {
      groupBy: async () => [
        { emergencyId: 'emergency-1', offlineStatus: 'failed', restoreStatus: 'pending', _count: { _all: 1 } },
      ],
    },
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);

  const result = await service.timeline('emergency-1', 2, 10, 'shutdown', 'worker', 'failed');

  assert.deepEqual((eventQuery?.where as Record<string, unknown>), {
    emergencyId: 'emergency-1', phase: 'shutdown', source: 'worker', outcome: 'failed',
  });
  assert.deepEqual(eventQuery?.orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
  assert.equal(eventQuery?.skip, 10);
  assert.equal(result.counts.shutdownFailed, 1);
  assert.equal(result.page, 2);
});

test('target error filter respects the selected phase and caps pagination', async () => {
  let targetWhere: Record<string, unknown> | undefined;
  const prisma = {
    storeEmergency: { findUnique: async () => ({ id: 'emergency-1' }) },
    storeEmergencyTarget: {
      findMany: async (query: { where: Record<string, unknown> }) => {
        targetWhere = query.where;
        return [];
      },
      count: async () => 0,
    },
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);

  const result = await service.targets('emergency-1', 1, 500, undefined, 'shutdown', undefined, 'true');

  const serialized = JSON.stringify(targetWhere);
  assert.match(serialized, /offlineStatus|offlineError/);
  assert.doesNotMatch(serialized, /restoreStatus|restoreError/);
  assert.equal(result.limit, 200);
});

test('reopening changes persist user actor, source and old/new schedule atomically', async () => {
  let eventData: Record<string, unknown> | undefined;
  const tx = {
    storeEmergency: { updateMany: async () => ({ count: 1 }) },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        eventData = data;
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => ({ id: 'emergency-1', status: 'offline', endsAt: new Date('2026-08-20T12:00:00Z') }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const service = new StoreEmergencyService(prisma as never, {} as never);
  (service as unknown as { findOne: (id: string) => Promise<Record<string, unknown>> }).findOne = async () => ({});

  await service.updateReopening(
    'emergency-1',
    { endsAt: new Date(Date.now() + 3_600_000) },
    'actor-2',
  );

  assert.equal(eventData?.type, 'reopening_rescheduled');
  assert.equal(eventData?.source, 'user');
  assert.equal(eventData?.actorId, 'actor-2');
  assert.ok((eventData?.metadata as Record<string, unknown>).previousEndsAt);
  assert.ok((eventData?.metadata as Record<string, unknown>).newEndsAt);
});

test('retry uses an advisory lock and refuses a stale second claim', async () => {
  let lockCalls = 0;
  let queueCalls = 0;
  let transactionOptions: Record<string, unknown> | undefined;
  const tx = {
    $executeRaw: async () => { lockCalls += 1; return 1; },
    storeEmergencyTarget: {
      findFirst: async () => null,
      updateMany: async () => {
        assert.fail('A stale retry must not reset targets');
      },
    },
    storeEmergency: {
      findFirst: async () => null,
      findUnique: async () => emergency({
        status: 'failed',
        endsAt: new Date(Date.now() + 3_600_000),
        targets: [{
          id: 'target-1', shopId: 'shop-1', offlineStatus: 'failed', restoreStatus: 'pending',
        }],
      }),
      updateMany: async () => ({ count: 0 }),
    },
    storeEmergencyEvent: { create: async () => ({}) },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'failed',
        endsAt: new Date(Date.now() + 3_600_000),
        targets: [{
          id: 'target-1', shopId: 'shop-1', offlineStatus: 'failed', restoreStatus: 'pending',
        }],
      }),
    },
    storeEmergencyTarget: { findFirst: async () => null },
    $transaction: async (
      callback: (client: typeof tx) => Promise<unknown>,
      options: Record<string, unknown>,
    ) => {
      transactionOptions = options;
      return callback(tx);
    },
  };
  const queue = { add: async () => { queueCalls += 1; } };
  const service = new StoreEmergencyService(prisma as never, queue as never);

  await assert.rejects(
    service.retryFailures('emergency-1', 'actor-2'),
    /already changing status/,
  );

  assert.equal(lockCalls, 1);
  assert.equal(queueCalls, 0);
  assert.deepEqual(transactionOptions, { maxWait: 10_000, timeout: 45_000 });
});

test('legacy restore retry fills missing requested and queued milestones', async () => {
  let requestUpdate: Record<string, unknown> | undefined;
  let queuedUpdate: Record<string, unknown> | undefined;
  const tx = {
    $executeRaw: async () => 1,
    storeEmergencyTarget: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
    },
    storeEmergency: {
      findFirst: async () => null,
      findUnique: async () => emergency({
        status: 'restore_failed',
        restoreRequestedAt: null,
        restoreQueuedAt: null,
        targets: [{
          id: 'target-1', shopId: 'shop-1', offlineStatus: 'done', restoreStatus: 'failed',
        }],
      }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('restoreRequestedAt' in data) requestUpdate = data;
        if ('restoreQueuedAt' in data) queuedUpdate = data;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ updatedAt: date }),
    },
    storeEmergencyEvent: { create: async () => ({}) },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'restore_failed',
        restoreRequestedAt: null,
        restoreQueuedAt: null,
        targets: [{
          id: 'target-1', shopId: 'shop-1', offlineStatus: 'done', restoreStatus: 'failed',
        }],
      }),
    },
    storeEmergencyTarget: { findFirst: async () => null },
    storeEmergencyEvent: { create: async () => ({}) },
    $transaction: async (operation: unknown) => {
      if (typeof operation === 'function') {
        return (operation as (client: typeof tx) => Promise<unknown>)(tx);
      }
      return Promise.all(operation as Promise<unknown>[]);
    },
  };
  const service = new StoreEmergencyService(
    prisma as never,
    { add: async () => ({ id: 'restore-retry', timestamp: date.getTime() }) } as never,
  );
  (service as unknown as { findOne: (id: string) => Promise<Record<string, unknown>> }).findOne = async () => ({});

  await service.retryFailures('emergency-1', 'actor-2');

  assert.ok(requestUpdate?.restoreRequestedAt instanceof Date);
  assert.equal((queuedUpdate?.restoreQueuedAt as Date).toISOString(), date.toISOString());
});

test('restore retry keeps an ambiguous durable ownership target retryable', async () => {
  const targetUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let queueCalls = 0;
  const ambiguousTarget = {
    id: 'target-ambiguous',
    shopId: 'shop-ambiguous',
    offlineStatus: 'failed',
    restoreStatus: 'required',
    restoreAttempts: 0,
    shop: { id: 'shop-ambiguous', shopId: 'S-AMBIGUOUS' },
  };
  const tx = {
    $executeRaw: async () => 1,
    storeEmergencyTarget: {
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        targetUpdates.push(input);
        return { count: 1 };
      },
    },
    storeEmergency: {
      findFirst: async () => null,
      findUnique: async () => emergency({
        status: 'restore_failed',
        finishedAt: date,
        restoreRequestedAt: date,
        targets: [ambiguousTarget],
      }),
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ updatedAt: date }),
    },
    storeEmergencyEvent: { create: async () => ({}) },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'restore_failed',
        finishedAt: date,
        restoreRequestedAt: date,
        targets: [ambiguousTarget],
      }),
    },
    $transaction: async (operation: unknown) => {
      if (typeof operation === 'function') {
        return (operation as (client: typeof tx) => Promise<unknown>)(tx);
      }
      return Promise.all(operation as Promise<unknown>[]);
    },
  };
  const service = new StoreEmergencyService(prisma as never, {
    add: async () => {
      queueCalls += 1;
      return { id: 'ambiguous-restore-retry', timestamp: date.getTime() };
    },
  } as never);
  (service as unknown as { findOne: (id: string) => Promise<Record<string, unknown>> }).findOne = async () => ({});

  await service.retryFailures('emergency-1', 'actor-2');

  assert.equal(queueCalls, 1);
  assert.equal(targetUpdates.length, 1);
  assert.deepEqual(targetUpdates[0].data, { restoreStatus: 'required', restoreError: null });
});

test('processor defers finalization while another worker still owns a target', async () => {
  const events: Array<Record<string, unknown>> = [];
  let transactionCalls = 0;
  const prisma = {
    storeEmergency: { findUnique: async () => emergency({ status: 'running' }) },
    storeEmergencyTarget: {
      groupBy: async () => [
        { offlineStatus: 'done', restoreStatus: 'pending', _count: { _all: 1 } },
        { offlineStatus: 'running', restoreStatus: 'pending', _count: { _all: 1 } },
      ],
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
    $transaction: async () => { transactionCalls += 1; },
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    finalize: (id: string, action: string, job: Record<string, unknown>, attempt: number) => Promise<void>;
  }).finalize('emergency-1', 'offline', {
    id: 'job-1', data: { emergencyId: 'emergency-1', action: 'offline', source: 'user' },
  }, 1);

  assert.equal(transactionCalls, 0);
  assert.equal(events[0].type, 'finalization_deferred');
});

test('late shutdown finalization cannot overwrite a newer emergency state', async () => {
  let finalizeClaims = 0;
  let aggregateEvents = 0;
  const tx = {
    storeEmergency: {
      updateMany: async () => {
        finalizeClaims += 1;
        return { count: 0 };
      },
    },
    storeEmergencyEvent: {
      create: async () => {
        aggregateEvents += 1;
        return {};
      },
    },
  };
  const prisma = {
    storeEmergency: { findUnique: async () => emergency({ status: 'restoring' }) },
    storeEmergencyTarget: {
      groupBy: async () => [
        { offlineStatus: 'done', restoreStatus: 'pending', _count: { _all: 2 } },
      ],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    finalize: (id: string, action: string, job: Record<string, unknown>, attempt: number) => Promise<void>;
  }).finalize('emergency-1', 'offline', {
    id: 'late-job', data: { emergencyId: 'emergency-1', action: 'offline', source: 'system' },
  }, 1);

  assert.equal(finalizeClaims, 1);
  assert.equal(aggregateEvents, 0);
});

test('late worker failure cannot degrade an already terminal emergency', async () => {
  let targetWrites = 0;
  let eventWrites = 0;
  const tx = {
    storeEmergency: { updateMany: async () => ({ count: 0 }) },
    storeEmergencyTarget: {
      updateMany: async () => { targetWrites += 1; return { count: 1 }; },
    },
    storeEmergencyEvent: {
      create: async () => { eventWrites += 1; return {}; },
    },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'offline',
        targets: [{ id: 'target-1', offlineAttempts: 1, restoreAttempts: 0 }],
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    failEmergency: (
      id: string,
      action: string,
      message: string,
      job: Record<string, unknown>,
      attempt: number,
    ) => Promise<void>;
  }).failEmergency('emergency-1', 'offline', 'late failure', {
    id: 'late-job', data: { source: 'worker' },
  }, 2);

  assert.equal(targetWrites, 0);
  assert.equal(eventWrites, 0);
});

test('global shutdown failure preserves partial-success protection when a store is already offline', async () => {
  let emergencyUpdate: Record<string, unknown> | undefined;
  const aggregateEvents: Array<Record<string, unknown>> = [];
  const tx = {
    storeEmergencyTarget: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ id: 'target-2', offlineAttempts: 1, restoreAttempts: 0 }],
      groupBy: async () => [
        { offlineStatus: 'done', restoreStatus: 'pending', _count: { _all: 1 } },
        { offlineStatus: 'failed', restoreStatus: 'pending', _count: { _all: 1 } },
      ],
    },
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('status' in data) emergencyUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      createMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        aggregateEvents.push(data);
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'running',
        targets: [{ id: 'target-2', offlineAttempts: 1, restoreAttempts: 0 }],
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    failEmergency: (
      id: string,
      action: string,
      message: string,
      job: Record<string, unknown>,
      attempt: number,
    ) => Promise<void>;
  }).failEmergency('emergency-1', 'offline', 'worker crashed', {
    id: 'job-1', data: { source: 'user', actorId: 'actor-1' },
  }, 1);

  assert.equal(emergencyUpdate?.status, 'partial_success');
  assert.equal(emergencyUpdate?.finishedAt, null);
  assert.equal(aggregateEvents.at(-1)?.type, 'shutdown_partial');
});

test('global shutdown failure keeps an ambiguous owned closure live', async () => {
  let emergencyUpdate: Record<string, unknown> | undefined;
  let aggregateEvent: Record<string, unknown> | undefined;
  const tx = {
    storeEmergencyTarget: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ id: 'target-ambiguous', offlineAttempts: 1, restoreAttempts: 0 }],
      groupBy: async () => [{
        offlineStatus: 'failed', restoreStatus: 'required', _count: { _all: 1 },
      }],
    },
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('status' in data) emergencyUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      createMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        aggregateEvent = data;
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'running',
        targets: [{ id: 'target-ambiguous', offlineAttempts: 1, restoreAttempts: 0 }],
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    failEmergency: (
      id: string,
      action: string,
      message: string,
      job: Record<string, unknown>,
      attempt: number,
    ) => Promise<void>;
  }).failEmergency('emergency-1', 'offline', 'worker crashed after OFF', {
    id: 'job-ambiguous', data: { source: 'user' },
  }, 1);

  assert.equal(emergencyUpdate?.status, 'partial_success');
  assert.equal(emergencyUpdate?.finishedAt, null);
  assert.equal(aggregateEvent?.type, 'shutdown_partial');
  assert.equal((aggregateEvent?.metadata as Record<string, unknown>).shutdownAmbiguous, 1);
});

test('global restore failure preserves ambiguous durable ownership for a safe retry', async () => {
  const targetUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let emergencyUpdate: Record<string, unknown> | undefined;
  const tx = {
    storeEmergencyTarget: {
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        targetUpdates.push(input);
        return { count: 1 };
      },
      findMany: async () => [{ id: 'target-ambiguous', offlineAttempts: 1, restoreAttempts: 0 }],
      groupBy: async () => [{
        offlineStatus: 'failed', restoreStatus: 'required', _count: { _all: 1 },
      }],
    },
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('status' in data) emergencyUpdate = data;
        return { count: 1 };
      },
    },
    storeEmergencyEvent: {
      createMany: async () => ({ count: 1 }),
      create: async () => ({}),
    },
  };
  const prisma = {
    storeEmergency: {
      findUnique: async () => emergency({
        status: 'restoring',
        finishedAt: null,
        targets: [{ id: 'target-ambiguous', offlineAttempts: 1, restoreAttempts: 0 }],
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const processor = new StoreEmergencyProcessor(prisma as never, {} as never, {} as never);

  await (processor as unknown as {
    failEmergency: (
      id: string,
      action: string,
      message: string,
      job: Record<string, unknown>,
      attempt: number,
    ) => Promise<void>;
  }).failEmergency('emergency-1', 'restore', 'credentials unavailable', {
    id: 'restore-job', data: { source: 'scheduler' },
  }, 1);

  const ambiguousWrite = targetUpdates.find(update => update.data.restoreStatus === 'required');
  assert.ok(ambiguousWrite);
  assert.equal(ambiguousWrite.data.restoreError, 'credentials unavailable');
  assert.equal(emergencyUpdate?.status, 'restore_failed');
});

test('scheduler records automatic restore source and uses the BullMQ job timestamp', async () => {
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('restoreQueuedAt' in data) updates.push(data);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ updatedAt: date }),
    },
    storeEmergencyEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1', brandId: 'brand-1', status: 'offline', updatedAt: date, endsAt: date,
        restoreRequestedAt: null, restoreQueuedAt: null,
      }],
    },
    $transaction: async (operation: unknown) => {
      if (typeof operation === 'function') return (operation as (client: typeof tx) => Promise<unknown>)(tx);
      return Promise.all(operation as Promise<unknown>[]);
    },
  };
  const queue = {
    add: async (_name: string, data: Record<string, unknown>) => {
      assert.equal(data.source, 'scheduler');
      return { id: 'restore-job', timestamp: date.getTime() };
    },
  };
  const scheduler = new StoreEmergencyScheduler(prisma as never, queue as never);

  await scheduler.restoreExpiredEmergencies();

  assert.deepEqual(events.map(event => event.type), ['restore_requested', 'restore_queued']);
  assert.equal(events[0].source, 'scheduler');
  assert.equal((events[1].occurredAt as Date).toISOString(), date.toISOString());
  assert.equal(updates.length, 1);
});

test('scheduler queue failure rolls back to a retryable offline state without inventing a finish', async () => {
  let emergencyUpdate: Record<string, unknown> | undefined;
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.status === 'offline') emergencyUpdate = data;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ updatedAt: date }),
    },
    storeEmergencyTarget: { updateMany: async () => ({ count: 1 }) },
    storeEmergencyEvent: {
      createMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1', brandId: 'brand-1', status: 'offline', updatedAt: date, endsAt: date,
        restoreRequestedAt: null, restoreQueuedAt: null,
      }],
    },
    storeEmergencyTarget: {
      findMany: async () => [{ id: 'target-1', restoreAttempts: 0 }],
    },
    $transaction: async (
      callback: (client: typeof tx) => Promise<unknown>,
    ) => callback(tx),
  };
  const scheduler = new StoreEmergencyScheduler(
    prisma as never,
    { add: async () => { throw new Error('redis://:password@host unavailable'); } } as never,
  );

  await scheduler.restoreExpiredEmergencies();

  assert.equal(emergencyUpdate?.status, 'offline');
  assert.equal('finishedAt' in (emergencyUpdate ?? {}), false);
  assert.equal('restoreStartedAt' in (emergencyUpdate ?? {}), false);
  assert.equal('restoreFinishedAt' in (emergencyUpdate ?? {}), false);
  assert.equal(events.at(-1)?.type, 'queue_failed');
  assert.doesNotMatch(String(events.at(-1)?.message), /password/);
});

test('recovery re-enqueues only a stale pending shutdown with no running target', async () => {
  const events: Array<Record<string, unknown>> = [];
  let queuedAction: unknown;
  let recoveryOptions: Record<string, unknown> | undefined;
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findUnique: async () => ({ status: 'pending', updatedAt: date, finishedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    storeEmergencyTarget: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
    },
    storeEmergencyEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1', status: 'pending', updatedAt: date, shutdownQueuedAt: date,
        restoreQueuedAt: null, events: [],
      }],
    },
    $transaction: async (operation: unknown, options?: Record<string, unknown>) => {
      if (typeof operation === 'function') {
        if (options) recoveryOptions = options;
        return (operation as (client: typeof tx) => Promise<unknown>)(tx);
      }
      return Promise.all(operation as Promise<unknown>[]);
    },
  };
  const queue = {
    add: async (_name: string, data: Record<string, unknown>) => {
      queuedAction = data.action;
      return { id: 'recovery-job', timestamp: date.getTime() };
    },
  };
  const scheduler = new StoreEmergencyScheduler(prisma as never, queue as never);

  await scheduler.recoverStaleTransitions();

  assert.equal(queuedAction, 'offline');
  assert.deepEqual(recoveryOptions, { maxWait: 10_000, timeout: 30_000 });
  assert.deepEqual(events.map(event => event.type), ['stale_transition_recovered', 'recovery_queued']);
});

test('recovery resets and re-enqueues a stale running shutdown lease', async () => {
  let queueCalls = 0;
  let resetCalls = 0;
  const events: string[] = [];
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findUnique: async () => ({ status: 'running', updatedAt: date, finishedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    storeEmergencyTarget: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.offlineStatus === 'pending') resetCalls += 1;
        return { count: 1 };
      },
      findFirst: async () => null,
    },
    storeEmergencyEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(String(data.type));
        return data;
      },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1', status: 'running', updatedAt: date, shutdownQueuedAt: date,
        restoreQueuedAt: null, events: [],
      }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const scheduler = new StoreEmergencyScheduler(
    prisma as never,
    { add: async () => { queueCalls += 1; return { id: 'recovery-job', timestamp: date.getTime() }; } } as never,
  );

  await scheduler.recoverStaleTransitions();

  assert.equal(queueCalls, 1);
  assert.equal(resetCalls, 1);
  assert.deepEqual(events, ['stale_transition_recovered', 'recovery_queued']);
});

test('recovery never enqueues after losing the parent CAS following a target reset', async () => {
  let queueCalls = 0;
  let resetCalls = 0;
  let auditCalls = 0;
  const tx = {
    $executeRaw: async () => 1,
    storeEmergency: {
      findUnique: async () => ({ status: 'running', updatedAt: date, finishedAt: null }),
      updateMany: async () => ({ count: 0 }),
    },
    storeEmergencyTarget: {
      updateMany: async () => { resetCalls += 1; return { count: 1 }; },
      findFirst: async () => null,
    },
    storeEmergencyEvent: {
      findFirst: async () => null,
      create: async () => { auditCalls += 1; },
    },
  };
  const prisma = {
    storeEmergency: {
      findMany: async () => [{
        id: 'emergency-1', status: 'running', updatedAt: date, shutdownQueuedAt: date,
        restoreQueuedAt: null, events: [],
      }],
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const scheduler = new StoreEmergencyScheduler(
    prisma as never,
    { add: async () => { queueCalls += 1; return { id: 'unexpected-job', timestamp: date.getTime() }; } } as never,
  );

  await scheduler.recoverStaleTransitions();

  assert.equal(resetCalls, 1);
  assert.equal(auditCalls, 0);
  assert.equal(queueCalls, 0);
});

test('emergency log sanitizer redacts JSON, bearer and URI credentials', () => {
  const sanitized = sanitizeEmergencyMessage(
    'Authorization: Bearer secret.jwt {"Authorization":"Bearer topsecret","auth_token":"abc"} '
      + '?access_token=querysecret&api_key=keysecret client_secret=clientsecret '
      + 'redis://:password@host app_secret=value',
  );
  assert.doesNotMatch(
    sanitized,
    /secret\.jwt|topsecret|"abc"|querysecret|keysecret|clientsecret|:password@|app_secret=value/,
  );
  assert.match(sanitized, /\[REDACTED\]/);
});
