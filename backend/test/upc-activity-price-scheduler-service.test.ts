import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UpcActivityPriceScheduler } from '../src/file-integrations/upc-activity-price.scheduler';
import { UpcActivityPriceService } from '../src/file-integrations/upc-activity-price.service';

const ruleId = 'rule-1';
const executionId = 'execution-1';

function config() {
  return { get: (_key: string, fallback: string) => fallback };
}

test('startup and minute reconciliation requeue the same active execution without creating a new run', async () => {
  const reconciled: string[] = [];
  let newRuns = 0;
  const prisma = {
    upcActivityPriceExecution: {
      findMany: async () => [{ id: executionId }],
    },
    upcActivityPriceRule: {
      findMany: async () => [],
    },
  };
  const service = {
    ensureExecutionQueued: async (id: string) => {
      reconciled.push(id);
      return 'queued' as const;
    },
    run: async () => {
      newRuns += 1;
    },
  };
  const scheduler = new UpcActivityPriceScheduler(prisma as never, service as never);

  await scheduler.onModuleInit();
  await scheduler.scheduleDueRules();

  assert.deepEqual(reconciled, [executionId, executionId]);
  assert.equal(newRuns, 0);
});

test('execution reconciliation does not duplicate a live Bull job', async () => {
  let added = 0;
  const primaryJob = {
    getState: async () => 'active',
  };
  const queue = {
    getJob: async (id: string) => id === executionId ? primaryJob : null,
    add: async () => {
      added += 1;
      return {};
    },
  };
  const tx = {
    $executeRaw: async () => 1,
    upcActivityPriceExecution: {
      findUnique: async () => ({ status: 'running', result: null }),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  assert.equal(await service.ensureExecutionQueued(executionId), 'live');
  assert.equal(await service.ensureExecutionQueued(executionId), 'live');
  assert.equal(added, 0);
});

test('execution reconciliation requeues the same durable execution after a terminal Bull job', async () => {
  const added: Array<{
    name: string;
    data: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  let terminalRecoveryRemoved = 0;
  const queue = {
    getJob: async (id: string) => id === `${executionId}-recovery`
      ? {
          getState: async () => 'failed',
          remove: async () => { terminalRecoveryRemoved += 1; },
        }
      : {
          getState: async () => 'completed',
          remove: async () => undefined,
        },
    add: async (
      name: string,
      data: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      added.push({ name, data, options });
      return {};
    },
  };
  const tx = {
    $executeRaw: async () => 1,
    upcActivityPriceExecution: {
      findUnique: async () => ({ status: 'running', result: null }),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  assert.equal(await service.ensureExecutionQueued(executionId), 'queued');
  assert.equal(terminalRecoveryRemoved, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'upc-activity-price-run');
  assert.deepEqual(added[0].data, { executionId });
  assert.equal(added[0].options.jobId, `${executionId}-recovery`);
});

test('execution reconciliation never queues an execution marked for manual review', async () => {
  let queueReads = 0;
  let added = 0;
  const queue = {
    getJob: async () => {
      queueReads += 1;
      return null;
    },
    add: async () => {
      added += 1;
      return {};
    },
  };
  const tx = {
    $executeRaw: async () => 1,
    upcActivityPriceExecution: {
      findUnique: async () => ({
        status: 'running',
        result: { requiresManualReview: true },
      }),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  assert.equal(await service.ensureExecutionQueued(executionId), 'manual_review');
  assert.equal(queueReads, 0);
  assert.equal(added, 0);
});

test('stopping a pending execution cancels it and removes only non-active Bull jobs', async () => {
  let storedStatus = 'pending';
  let pendingUpdate: Record<string, unknown> | undefined;
  let waitingRemoved = 0;
  let activeRemoved = 0;
  const jobs = {
    [executionId]: {
      getState: async () => 'waiting',
      remove: async () => { waitingRemoved += 1; },
    },
    [`${executionId}-recovery`]: {
      getState: async () => 'active',
      remove: async () => { activeRemoved += 1; },
    },
  };
  const prisma = {
    upcActivityPriceRule: {
      findFirst: async () => ({ id: ruleId }),
    },
    upcActivityPriceExecution: {
      findMany: async () => [{ id: executionId, status: 'pending' }],
      updateMany: async (args: {
        where: { status: string };
        data: Record<string, unknown>;
      }) => {
        if (args.where.status === 'pending') {
          pendingUpdate = args.data;
          storedStatus = 'cancelled';
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async () => ({ status: storedStatus }),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const queue = {
    getJob: async (id: keyof typeof jobs) => jobs[id] ?? null,
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  const result = await service.stop(ruleId);

  assert.deepEqual(result, {
    stopped: true,
    monitoringAcceptedTasks: false,
    manualReviewClosed: false,
  });
  assert.equal(pendingUpdate?.cancelRequested, true);
  assert.equal(pendingUpdate?.status, 'cancelled');
  assert.ok(pendingUpdate?.finishedAt instanceof Date);
  assert.equal(waitingRemoved, 1);
  assert.equal(activeRemoved, 0);
});

test('stopping a running execution leaves its Bull job and requests cooperative cancellation', async () => {
  let runningUpdate: Record<string, unknown> | undefined;
  let queueReads = 0;
  const prisma = {
    upcActivityPriceRule: {
      findFirst: async () => ({ id: ruleId }),
    },
    upcActivityPriceExecution: {
      findMany: async () => [{ id: executionId, status: 'running' }],
      updateMany: async (args: {
        where: { status: string; id?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        if (args.where.status === 'running' && args.where.id?.in.includes(executionId)) {
          runningUpdate = args.data;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const queue = {
    getJob: async () => {
      queueReads += 1;
      return null;
    },
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  const result = await service.stop(ruleId);

  assert.deepEqual(result, {
    stopped: true,
    monitoringAcceptedTasks: true,
    manualReviewClosed: false,
  });
  assert.equal(runningUpdate?.cancelRequested, true);
  assert.equal(runningUpdate?.status, undefined);
  assert.match(String(runningUpdate?.errorMessage), /monitoring accepted remote tasks/i);
  assert.equal(queueReads, 0);
});

test('stopping a manual-review execution closes it terminally and unblocks the rule', async () => {
  let storedStatus = 'running';
  let manualReviewUpdate: Record<string, unknown> | undefined;
  let waitingRemoved = 0;
  const prisma = {
    upcActivityPriceRule: {
      findFirst: async () => ({ id: ruleId }),
    },
    upcActivityPriceExecution: {
      findMany: async () => [{
        id: executionId,
        status: 'running',
        result: { requiresManualReview: true },
      }],
      updateMany: async (args: {
        where: { status: string; id?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        if (args.where.status === 'running' && args.where.id?.in.includes(executionId)) {
          manualReviewUpdate = args.data;
          storedStatus = 'cancelled';
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async () => ({ status: storedStatus }),
      count: async () => ['pending', 'running'].includes(storedStatus) ? 1 : 0,
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const queue = {
    getJob: async (id: string) => id === executionId ? {
      getState: async () => 'waiting',
      remove: async () => { waitingRemoved += 1; },
    } : null,
  };
  const service = new UpcActivityPriceService(prisma as never, config() as never, queue as never);

  const result = await service.stop(ruleId);

  assert.deepEqual(result, {
    stopped: true,
    monitoringAcceptedTasks: false,
    manualReviewClosed: true,
  });
  assert.equal(manualReviewUpdate?.cancelRequested, true);
  assert.equal(manualReviewUpdate?.status, 'cancelled');
  assert.ok(manualReviewUpdate?.finishedAt instanceof Date);
  assert.match(String(manualReviewUpdate?.errorMessage), /manual review acknowledged/i);
  assert.equal(storedStatus, 'cancelled');
  assert.equal(waitingRemoved, 1);
  await (service as unknown as {
    assertNotRunning(value: string): Promise<void>;
  }).assertNotRunning(ruleId);
});
