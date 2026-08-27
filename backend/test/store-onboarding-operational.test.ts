import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountRole,
  AssignmentStrategy,
  Country,
  ExecutionType,
  KaType,
  PrismaClient,
  ShopStatus,
  StepFailureReason,
  StepStatus,
  StoreOnboardingAuditStatus,
  StoreOnboardingEnrollmentDecision,
  StoreOnboardingSource,
  StoreOnboardingStage,
  TaskStatus,
} from '@prisma/client';
import {
  calculateStoreOnboardingStageInterval,
  calculateStoreOnboardingTimelineEffort,
  StoreOnboardingLifecycleService,
} from '../src/store-onboarding/store-onboarding-lifecycle.service';
import {
  StoreOnboardingAmbiguousGoLiveError,
  StoreOnboardingGoLiveGateway,
  StoreOnboardingRemoteOfflineError,
  StoreOnboardingRemoteRejectedError,
} from '../src/store-onboarding/store-onboarding-go-live.gateway';
import { StoreOnboardingService } from '../src/store-onboarding/store-onboarding.service';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { TaskEngineService } from '../src/tasks/task-engine.service';
import { HandlerProcessor, registerHandler } from '../src/queue/handler.processor';
import { QueueModule } from '../src/queue/queue.module';

const MANAGER_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000002';
const COMMERCIAL_ID = '10000000-0000-4000-8000-000000000003';
const BEVERLY_ID = '10000000-0000-4000-8000-000000000004';
const OUTSIDER_ID = '10000000-0000-4000-8000-000000000005';

const manager = {
  id: MANAGER_ID,
  email: 'manager@example.com',
  roles: [AccountRole.admin],
  sectionId: null as string | null,
  adminModules: [],
  bpoPermissions: [],
};
const owner = { ...manager, id: OWNER_ID, email: 'owner@example.com', roles: [AccountRole.user] };
const commercial = { ...manager, id: COMMERCIAL_ID, email: 'commercial@example.com', roles: [AccountRole.user] };
const beverly = { ...manager, id: BEVERLY_ID, email: 'beverly@example.com', roles: [AccountRole.user] };
const outsider = { ...manager, id: OUTSIDER_ID, email: 'outsider@example.com', roles: [AccountRole.user] };

test('Go-Live POST retryable HTTP responses are ambiguous while definitive 4xx/business errors are rejected', async () => {
  const gateway = new StoreOnboardingGoLiveGateway({} as never);
  (gateway as unknown as { authenticate: () => Promise<string> }).authenticate = async () => 'fictional-token';
  const originalFetch = globalThis.fetch;
  const input = { appId: 'app', encryptedAppSecret: 'secret', appShopId: 'shop' };
  try {
    for (const status of [408, 425, 429, 500, 503]) {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ errno: 9001, errmsg: `fictional HTTP ${status}` }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
      await assert.rejects(
        gateway.open(input),
        error => error instanceof StoreOnboardingAmbiguousGoLiveError,
      );
    }

    globalThis.fetch = async () => new Response(
      JSON.stringify({ errno: 4001, errmsg: 'definitive invalid request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
    await assert.rejects(
      gateway.open(input),
      error => error instanceof StoreOnboardingRemoteRejectedError,
    );

    globalThis.fetch = async () => new Response(
      JSON.stringify({ errno: 17, errmsg: 'business rule rejected' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    await assert.rejects(
      gateway.open(input),
      error => error instanceof StoreOnboardingRemoteRejectedError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Go-Live authentication can finish before the locked provider-write path starts', async () => {
  const gateway = new StoreOnboardingGoLiveGateway({} as never);
  let authenticationCalls = 0;
  (gateway as unknown as { authenticate: () => Promise<string> }).authenticate = async () => {
    authenticationCalls += 1;
    return 'fictional-prepared-token';
  };
  const input = { appId: 'app', encryptedAppSecret: 'secret', appShopId: 'shop' };
  const token = await gateway.prepare(input);
  (gateway as unknown as { authenticate: () => Promise<string> }).authenticate = async () => {
    throw new Error('authentication must not run inside openAuthenticated');
  };
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request: string | URL | Request) => {
    const url = String(request);
    calls.push(url);
    if (url.includes('/setStatus')) {
      return new Response(JSON.stringify({ errno: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ errno: 0, data: { biz_status: 1 } }), { status: 200 });
  };
  try {
    const result = await gateway.openAuthenticated(input, token);
    assert.equal(result.remoteBizStatus, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(authenticationCalls, 1);
  assert.equal(calls.filter(url => url.includes('/setStatus')).length, 1);
  assert.equal(calls.filter(url => url.includes('/shop/detail')).length, 1);
});

test('control read failure is fail-closed and Task registration performs zero onboarding writes', async () => {
  let writes = 0;
  const unavailable = async () => {
    throw Object.assign(new Error('relation unavailable'), { code: 'P2021' });
  };
  const client = {
    storeOnboardingControl: { findUnique: unavailable },
    storeOnboardingRolloutSource: { findFirst: async () => { writes++; return null; } },
    storeOnboardingTaskEnrollment: { create: async () => { writes++; } },
    storeOnboardingRequest: { create: async () => { writes++; } },
    storeOnboardingOutboxEvent: { upsert: async () => { writes++; } },
  };
  const lifecycle = new StoreOnboardingLifecycleService(client as never);

  const result = await lifecycle.registerTaskAtCreation(client as never, {
    taskId: randomUUID(),
    taskTypeId: randomUUID(),
    createdAt: new Date(),
    scheduledStart: null,
    createdById: MANAGER_ID,
    brand: null,
  });

  assert.equal(result.reason, 'global_off');
  assert.equal(writes, 0);
});

test('master OFF blocks operational reads/writes and never calls the Go-Live gateway', async () => {
  let operationalReads = 0;
  let gatewayCalls = 0;
  const prisma = {
    storeOnboardingControl: { findUnique: async () => null },
    account: { findMany: async () => { operationalReads++; return []; } },
    storeOnboardingRequest: {
      findMany: async () => { operationalReads++; return []; },
      findUnique: async () => { operationalReads++; return null; },
    },
  };
  const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
  const service = new StoreOnboardingService(
    prisma as never,
    { can: async () => true } as never,
    lifecycle,
    { open: async () => { gatewayCalls++; return {}; } } as never,
  );

  await assert.rejects(service.list({}), ConflictException);
  await assert.rejects(service.assigneeOptions(manager), ConflictException);
  await assert.rejects(service.goLive(randomUUID(), { unitIds: [randomUUID()] }, manager), ConflictException);
  assert.equal(operationalReads, 0);
  assert.equal(gatewayCalls, 0);
});

test('published runtime source requires Brand, while a later published OFF revision keeps legacy Tasks untouched', async () => {
  const taskTypeId = randomUUID();
  const taskId = randomUUID();
  const control = {
    globalEnabled: true,
    notificationsEnabled: false,
    globalEnabledAt: new Date('2026-08-21T00:00:00.000Z'),
    notificationsEnabledAt: null,
  };
  const baseClient = {
    $executeRaw: async () => 1,
    storeOnboardingControl: { findUnique: async () => control },
  };
  const enabledClient = {
    ...baseClient,
    storeOnboardingRolloutRevision: {
      findMany: async () => [{
        id: randomUUID(),
        country: Country.MX,
        kaType: KaType.KA,
        revision: 1,
        enabled: true,
        effectiveAt: new Date('2026-08-21T00:00:00.000Z'),
        sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId }],
      }],
    },
  };
  const enabledLifecycle = new StoreOnboardingLifecycleService(enabledClient as never);
  await assert.rejects(enabledLifecycle.registerTaskAtCreation(enabledClient as never, {
    taskId,
    taskTypeId,
    createdAt: new Date('2026-08-21T01:00:00.000Z'),
    scheduledStart: null,
    createdById: MANAGER_ID,
    brand: null,
  }), UnprocessableEntityException);

  const disabledClient = {
    ...baseClient,
    storeOnboardingRolloutRevision: {
      findMany: async () => [
        {
          id: randomUUID(), country: Country.MX, kaType: KaType.KA, revision: 2, enabled: false,
          effectiveAt: new Date('2026-08-21T00:30:00.000Z'), sourceTaskTypes: [],
        },
        {
          id: randomUUID(), country: Country.MX, kaType: KaType.KA, revision: 1, enabled: true,
          effectiveAt: new Date('2026-08-21T00:00:00.000Z'),
          sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId }],
        },
      ],
    },
  };
  const disabledLifecycle = new StoreOnboardingLifecycleService(disabledClient as never);
  const result = await disabledLifecycle.registerTaskAtCreation(disabledClient as never, {
    taskId,
    taskTypeId,
    createdAt: new Date('2026-08-21T01:00:00.000Z'),
    scheduledStart: null,
    createdById: MANAGER_ID,
    brand: null,
  });
  assert.equal(result.reason, 'task_type_not_mapped');
});

test('a runtime Brand prerequisite Task Type requires a Brand but remains a legacy Task when its scope is OFF', async () => {
  const sourceTaskTypeId = randomUUID();
  const brandTaskTypeId = randomUUID();
  const taskId = randomUUID();
  const control = {
    globalEnabled: true,
    notificationsEnabled: false,
    globalEnabledAt: new Date('2026-08-21T00:00:00.000Z'),
    notificationsEnabledAt: null,
  };
  const runtimeRevision = {
    id: randomUUID(),
    country: Country.MX,
    kaType: KaType.KA,
    revision: 1,
    enabled: true,
    effectiveAt: new Date('2026-08-21T00:00:00.000Z'),
    brandTaskTypeId,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: sourceTaskTypeId }],
  };
  const activeClient = {
    $executeRaw: async () => 1,
    storeOnboardingControl: { findUnique: async () => control },
    storeOnboardingRolloutRevision: { findMany: async () => [runtimeRevision] },
  };
  const activeLifecycle = new StoreOnboardingLifecycleService(activeClient as never);
  const registration = {
    taskId,
    taskTypeId: brandTaskTypeId,
    createdAt: new Date('2026-08-21T01:00:00.000Z'),
    scheduledStart: null,
    createdById: MANAGER_ID,
  };
  await assert.rejects(
    activeLifecycle.registerTaskAtCreation(activeClient as never, { ...registration, brand: null }),
    UnprocessableEntityException,
  );
  const linked = await activeLifecycle.registerTaskAtCreation(activeClient as never, {
    ...registration,
    brand: {
      id: randomUUID(),
      country: Country.MX,
      kaType: KaType.KA,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  });
  assert.equal(linked.reason, 'brand_prerequisite_task');

  const offClient = {
    $executeRaw: async () => 1,
    storeOnboardingControl: { findUnique: async () => ({ ...control, globalEnabled: false }) },
    storeOnboardingRolloutRevision: { findMany: async () => { throw new Error('must not query rollout while OFF'); } },
  };
  const offLifecycle = new StoreOnboardingLifecycleService(offClient as never);
  const legacy = await offLifecycle.registerTaskAtCreation(offClient as never, { ...registration, brand: null });
  assert.equal(legacy.reason, 'global_off');
});

test('latest scope revision wins before Task Type matching so historical mappings never re-enroll', async () => {
  const oldTaskTypeId = randomUUID();
  const newTaskTypeId = randomUUID();
  const control = {
    globalEnabled: true,
    notificationsEnabled: false,
    globalEnabledAt: new Date('2026-08-21T00:00:00.000Z'),
    notificationsEnabledAt: null,
  };
  let enrollmentWrites = 0;
  const baseRevision = {
    country: Country.MX,
    kaType: KaType.KA,
    activatedAt: new Date('2026-08-21T00:00:00.000Z'),
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    brandTaskTypeId: null,
  };
  const client = {
    $executeRaw: async () => 1,
    storeOnboardingControl: { findUnique: async () => control },
    storeOnboardingRolloutRevision: {
      findMany: async () => [
        {
          ...baseRevision,
          id: randomUUID(),
          revision: 2,
          enabled: true,
          effectiveAt: new Date('2026-08-21T00:30:00.000Z'),
          sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: newTaskTypeId }],
        },
        {
          ...baseRevision,
          id: randomUUID(),
          revision: 1,
          enabled: true,
          effectiveAt: new Date('2026-08-21T00:00:00.000Z'),
          sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: oldTaskTypeId }],
        },
      ],
    },
    storeOnboardingTaskEnrollment: {
      findUnique: async () => null,
      create: async () => { enrollmentWrites++; },
    },
  };
  const lifecycle = new StoreOnboardingLifecycleService(client as never);
  const result = await lifecycle.registerTaskAtCreation(client as never, {
    taskId: randomUUID(),
    taskTypeId: oldTaskTypeId,
    createdAt: new Date('2026-08-21T01:00:00.000Z'),
    scheduledStart: null,
    createdById: MANAGER_ID,
    brand: {
      id: randomUUID(),
      country: Country.MX,
      kaType: KaType.KA,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  });
  assert.equal(result.enrolled, false);
  assert.equal(result.reason, 'source_not_mapped');
  assert.equal(enrollmentWrites, 0);
});

test('external online reconciliation cannot bypass RTBO readiness', async () => {
  let where: Record<string, unknown> | undefined;
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: false }),
    },
    storeOnboardingUnit: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        where = args.where;
        return [];
      },
    },
  };
  const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
  const service = new StoreOnboardingService(
    prisma as never,
    { can: async () => true } as never,
    lifecycle,
    {} as never,
  );
  assert.deepEqual(await service.reconcileOnline('shop-1', 'auto_open' as never), { changed: 0 });
  assert.deepEqual((where?.stage as { in?: StoreOnboardingStage[] })?.in, [
    StoreOnboardingStage.awaiting_go_live,
    StoreOnboardingStage.online_failed,
  ]);
  assert.deepEqual(where?.rtboAt, { not: null });
});

test('legacy TaskEngine advance stays independent of onboarding tables while master is OFF', async () => {
  let dependencyReads = 0;
  let taskDone = 0;
  const prisma: Record<string, unknown> & { $transaction?: unknown } = {
    $queryRaw: async () => [{ relation: null }],
    storeOnboardingControl: { findUnique: async () => null },
    taskDependency: { findFirst: async () => { dependencyReads++; return null; } },
    stepInstance: { findMany: async () => [], count: async () => 0 },
    task: {
      findUnique: async () => ({ status: TaskStatus.pending }),
      update: async () => { taskDone++; },
    },
  };
  prisma.$transaction = async (callback: (tx: typeof prisma) => unknown) => callback(prisma);
  const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
  const engine = new TaskEngineService(prisma as never, {} as never, lifecycle);

  await engine.advanceTask(randomUUID());

  assert.equal(dependencyReads, 0);
  assert.equal(taskDone, 1);
});

test('an enrolled Task rechecks the master under the activation transaction after Brand recovery', async () => {
  const taskId = randomUUID();
  const stepId = randomUUID();
  let enabled = false;
  let stepWrites = 0;
  let taskWrites = 0;
  let jobs = 0;
  const stepDefinition = {
    id: randomUUID(),
    order: 1,
    weight: 1,
    assignmentStrategy: 'manual',
    executionType: 'automatic',
    handlerId: randomUUID(),
    candidates: [],
  };
  const pending = {
    id: stepId,
    taskId,
    status: 'pending',
    stepDefinitionId: stepDefinition.id,
    stepDefinition,
    task: { id: taskId },
  };
  const tx = {
    $queryRaw: async () => [{ id: stepId }],
    $executeRaw: async () => 1,
    stepInstance: {
      findUnique: async () => pending,
      update: async () => { stepWrites++; },
    },
    task: { update: async () => { taskWrites++; } },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
    stepInstance: {
      findMany: async () => [pending],
      findUnique: async () => pending,
    },
  };
  const lifecycle = {
    isTaskBlockedByBrand: async () => false,
    canActivateTaskInTransaction: async (client: unknown, candidateTaskId: string) => {
      assert.equal(client, tx);
      assert.equal(candidateTaskId, taskId);
      return enabled;
    },
  };
  const engine = new TaskEngineService(prisma as never, {} as never, lifecycle as never);
  (engine as unknown as { sendStepWebhook: () => Promise<void> }).sendStepWebhook = async () => undefined;
  engine.emitAutoStep = () => { jobs++; };

  // Brand recovery committed first, then the master was disabled before the
  // dependent Task could claim its Step. The in-transaction fence must win.
  await engine.advanceTask(taskId);
  assert.equal(stepWrites, 0);
  assert.equal(taskWrites, 0);
  assert.equal(jobs, 0);

  enabled = true;
  await engine.advanceTask(taskId);
  assert.equal(stepWrites, 1);
  assert.equal(taskWrites, 1);
  assert.equal(jobs, 1);
});

test('scheduled activation is claimed once by TaskEngine and remains transparent for legacy Tasks', async t => {
  const run = async (enrolled: boolean, enabled: boolean, attempts: number) => {
    const taskId = randomUUID();
    const stepId = randomUUID();
    let taskStatus: TaskStatus = TaskStatus.scheduled;
    let stepStatus = 'pending';
    let stepWrites = 0;
    let taskWrites = 0;
    let jobs = 0;
    const stepDefinition = {
      id: randomUUID(),
      order: 1,
      weight: 1,
      assignmentStrategy: 'manual',
      executionType: 'automatic',
      handlerId: randomUUID(),
      candidates: [],
    };
    const step = () => ({
      id: stepId,
      taskId,
      status: stepStatus,
      stepDefinitionId: stepDefinition.id,
      stepDefinition,
      task: { id: taskId, status: taskStatus },
    });
    const tx = {
      $queryRaw: async () => [{ id: stepId }],
      $executeRaw: async () => 1,
      stepInstance: {
        findUnique: async () => step(),
        update: async (args: { data: { status?: string } }) => {
          stepWrites++;
          if (args.data.status) stepStatus = args.data.status;
        },
      },
      task: {
        update: async (args: { data: { status: TaskStatus } }) => {
          taskWrites++;
          taskStatus = args.data.status;
        },
      },
    };
    const prisma = {
      // Deliberately return the same stale scheduled candidate to model two
      // Scheduler replicas that queried before either activation committed.
      task: { findMany: async () => [{ id: taskId }] },
      stepInstance: {
        findFirst: async () => step(),
        findUnique: async () => step(),
      },
      $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
    };
    const lifecycle = {
      canActivateTaskInTransaction: async () => !enrolled || enabled,
    };
    const engine = new TaskEngineService(prisma as never, {} as never, lifecycle as never);
    (engine as unknown as { sendStepWebhook: () => Promise<void> }).sendStepWebhook = async () => undefined;
    engine.emitAutoStep = () => { jobs++; };
    const scheduler = new SchedulerService(prisma as never, engine, {} as never);

    for (let index = 0; index < attempts; index++) await scheduler.activateScheduledTasks();
    return { stepWrites, taskWrites, jobs, stepStatus, taskStatus };
  };

  await t.test('enrolled + master OFF leaves Task, Step and queue unchanged', async () => {
    assert.deepEqual(await run(true, false, 1), {
      stepWrites: 0,
      taskWrites: 0,
      jobs: 0,
      stepStatus: 'pending',
      taskStatus: TaskStatus.scheduled,
    });
  });
  await t.test('enrolled + master ON activates and queues exactly once across stale candidates', async () => {
    assert.deepEqual(await run(true, true, 2), {
      stepWrites: 1,
      taskWrites: 1,
      jobs: 1,
      stepStatus: 'in_progress',
      taskStatus: TaskStatus.in_progress,
    });
  });
  await t.test('legacy scheduled Task remains operational while onboarding master is OFF', async () => {
    assert.deepEqual(await run(false, false, 1), {
      stepWrites: 1,
      taskWrites: 1,
      jobs: 1,
      stepStatus: 'in_progress',
      taskStatus: TaskStatus.in_progress,
    });
  });
});

test('a stale or disabled Bull handler job never builds context or calls the registered handler', async () => {
  const handlerName = `store-onboarding-stale-${randomUUID()}`;
  let handlerCalls = 0;
  let prismaReads = 0;
  registerHandler(handlerName, async () => {
    handlerCalls++;
    return { shouldNotRun: true };
  });
  const engine = {
    runAutomaticHandlerUnderFence: async () => false,
  };
  const prisma = {
    task: { findUnique: async () => { prismaReads++; return null; } },
  };
  const processor = new HandlerProcessor(
    engine as never,
    prisma as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
  );

  await processor.process({
    data: { stepInstanceId: randomUUID(), handlerName, taskId: randomUUID() },
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as never);

  assert.equal(handlerCalls, 0);
  assert.equal(prismaReads, 0);
});

test('legacy automatic handlers run outside the long Prisma fence', async () => {
  let transactionCalls = 0;
  let completed = 0;
  const engine = new TaskEngineService({
    $transaction: async () => {
      transactionCalls++;
      throw new Error('legacy handler must not open the long transaction');
    },
  } as never, {} as never, {
    isTaskEnrolled: async () => false,
  } as never);
  engine.completeStep = async () => { completed++; };

  let effects = 0;
  assert.equal(await engine.runAutomaticHandlerUnderFence(
    randomUUID(),
    randomUUID(),
    async () => {
      effects++;
      assert.equal(transactionCalls, 0);
      return { status: 'completed' as const, result: { legacy: true } };
    },
  ), true);
  assert.equal(effects, 1);
  assert.equal(completed, 1);
  assert.equal(transactionCalls, 0);
});

test('handler enrollment routing is legacy only for an absent table/row and fails closed on read errors', async () => {
  const run = async (input: { relation: string | null; enrollment: object | null; error?: Error }) => {
    let effects = 0;
    let completions = 0;
    const prisma = {
      $queryRaw: async () => [{ relation: input.relation }],
      storeOnboardingTaskEnrollment: {
        findUnique: async () => {
          if (input.error) throw input.error;
          return input.enrollment;
        },
      },
    };
    const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
    const engine = new TaskEngineService(prisma as never, {} as never, lifecycle);
    engine.completeStep = async () => { completions++; };
    const execution = engine.runAutomaticHandlerUnderFence(randomUUID(), randomUUID(), async () => {
      effects++;
      return { status: 'completed' as const };
    });
    return { execution, counters: () => ({ effects, completions }) };
  };

  const noTable = await run({ relation: null, enrollment: null });
  assert.equal(await noTable.execution, true);
  assert.deepEqual(noTable.counters(), { effects: 1, completions: 1 });

  const noEnrollment = await run({ relation: 'store_onboarding_task_enrollment', enrollment: null });
  assert.equal(await noEnrollment.execution, true);
  assert.deepEqual(noEnrollment.counters(), { effects: 1, completions: 1 });

  const readFailure = await run({
    relation: 'store_onboarding_task_enrollment',
    enrollment: null,
    error: new Error('transient enrollment read failure'),
  });
  await assert.rejects(readFailure.execution, /transient enrollment read failure/);
  assert.deepEqual(readFailure.counters(), { effects: 0, completions: 0 });
});

test('Bull handler keeps legacy unknown/retry semantics and rejects after persisting final failure', async () => {
  const failingHandler = `store-onboarding-final-failure-${randomUUID()}`;
  registerHandler(failingHandler, async () => {
    throw new Error('fictional handler failure');
  });
  const outcomes: Array<{ status: string } | null> = [];
  const engine = {
    runAutomaticHandlerUnderFence: async (
      _stepId: string,
      _taskId: string,
      effect: () => Promise<{ status: string }>,
    ) => {
      const outcome = await effect();
      outcomes.push(outcome);
      return true;
    },
  };
  const processor = new HandlerProcessor(
    engine as never,
    {
      task: {
        findUnique: async () => ({
          createdById: MANAGER_ID,
          brand: null,
          formValues: [],
          taskShops: [],
        }),
      },
    } as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
  );

  await assert.doesNotReject(processor.process({
    data: { stepInstanceId: randomUUID(), handlerName: `unknown-${randomUUID()}`, taskId: randomUUID() },
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as never));
  assert.equal(outcomes.at(-1)?.status, 'failed');

  const beforeRetry = outcomes.length;
  await assert.rejects(processor.process({
    data: { stepInstanceId: randomUUID(), handlerName: failingHandler, taskId: randomUUID() },
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as never), /fictional handler failure/);
  assert.equal(outcomes.length, beforeRetry, 'non-final retry must not persist terminal failure');

  await assert.rejects(processor.process({
    data: { stepInstanceId: randomUUID(), handlerName: failingHandler, taskId: randomUUID() },
    attemptsMade: 1,
    opts: { attempts: 2 },
  } as never), /fictional handler failure/);
  assert.equal(outcomes.at(-1)?.status, 'failed');
});

test('a materialized Brand dependency remains a hard Task barrier after the master is turned OFF', async () => {
  let stepReads = 0;
  const prisma = {
    $queryRaw: async () => [{ relation: 'task_dependency' }],
    taskDependency: { findFirst: async () => ({ id: randomUUID() }) },
    stepInstance: { findMany: async () => { stepReads++; return []; } },
  };
  const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
  const engine = new TaskEngineService(prisma as never, {} as never, lifecycle);

  await engine.advanceTask(randomUUID());

  assert.equal(stepReads, 0);
});

test('TaskEngine Brand recovery advances each recovered dependent once and remains inert while OFF', async () => {
  const dependentTaskId = randomUUID();
  let enabled = false;
  let recoveryCalls = 0;
  const lifecycle = {
    control: async () => ({ globalEnabled: enabled }),
    recoverTerminalBrandProvisionings: async () => {
      recoveryCalls++;
      return recoveryCalls === 1 ? [dependentTaskId] : [];
    },
    recoverEnrolledPendingTaskActivations: async () => [],
    recoverEnrolledAutomaticHandlerJobs: async () => ({ activationEpoch: null, steps: [] }),
  };
  const engine = new TaskEngineService({} as never, {} as never, lifecycle as never);
  const advanced: string[] = [];
  engine.advanceTask = async taskId => { advanced.push(taskId); };

  await engine.recoverStoreOnboardingBrandTasks();
  assert.equal(recoveryCalls, 0);
  assert.deepEqual(advanced, []);

  enabled = true;
  await engine.recoverStoreOnboardingBrandTasks();
  await engine.recoverStoreOnboardingBrandTasks();
  assert.equal(recoveryCalls, 2);
  assert.deepEqual(advanced, [dependentTaskId]);
});

test('automatic handler recovery skips live jobs and uses one retained-safe job id per ON epoch', async () => {
  const stepInstanceId = randomUUID();
  const handlerId = randomUUID();
  const taskId = randomUUID();
  const states = new Map<string, string>([[stepInstanceId, 'waiting']]);
  const added: string[] = [];
  let failNextAdd = false;
  const queue = {
    getJob: async (jobId: string) => {
      const state = states.get(jobId);
      return state ? { getState: async () => state } : undefined;
    },
    add: async (_name: string, _data: unknown, options: { jobId: string }) => {
      if (failNextAdd) {
        failNextAdd = false;
        throw new Error('fictional Redis outage');
      }
      added.push(options.jobId);
      states.set(options.jobId, 'waiting');
    },
  };
  const engine = new TaskEngineService({} as never, {} as never);
  const queueModule = new QueueModule(
    queue as never,
    engine,
    { handler: { findUnique: async () => ({ name: 'fictional-handler' }) } } as never,
  );
  queueModule.onModuleInit();

  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '1000', '10'), false);
  assert.deepEqual(added, [], 'a waiting original job is its own live lease');

  states.set(stepInstanceId, 'completed');
  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '1000', '10'), true);
  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '1000', '10'), false);
  assert.deepEqual(added, [`${stepInstanceId}-onboarding-recovery-1000-10`]);

  // Bull may retain the completed recovery job. A new ON timestamp must still
  // publish a different id, while repeated scans in that epoch deduplicate.
  states.set(added[0], 'completed');
  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '2000', '10'), true);
  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '2000', '10'), false);
  assert.deepEqual(added, [
    `${stepInstanceId}-onboarding-recovery-1000-10`,
    `${stepInstanceId}-onboarding-recovery-2000-10`,
  ]);

  failNextAdd = true;
  await assert.rejects(
    engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '3000', '10'),
    /fictional Redis outage/,
  );
  assert.equal(await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '3000', '10'), true);
  assert.equal(added.at(-1), `${stepInstanceId}-onboarding-recovery-3000-10`);

  states.set(added.at(-1)!, 'failed');
  assert.equal(
    await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '3000', '20'),
    true,
  );
  assert.equal(added.at(-1), `${stepInstanceId}-onboarding-recovery-3000-20`);
  assert.equal(
    await engine.recoverAutoStepJob(stepInstanceId, handlerId, taskId, '3000', '20'),
    false,
  );
});

test('the production state machine keeps KA correction with OP and CKA/SME correction with Commercial', () => {
  const service = Object.create(StoreOnboardingService.prototype) as StoreOnboardingService;
  const state = service as unknown as {
    assertAllowedTransition(kaType: KaType, from: StoreOnboardingStage, to: StoreOnboardingStage): void;
  };

  assert.doesNotThrow(() => state.assertAllowedTransition(
    KaType.KA,
    StoreOnboardingStage.audit_rejected,
    StoreOnboardingStage.configuring,
  ));
  assert.throws(() => state.assertAllowedTransition(
    KaType.KA,
    StoreOnboardingStage.audit_rejected,
    StoreOnboardingStage.audit_preparing,
  ), ConflictException);
  for (const kaType of [KaType.CKA, KaType.SME]) {
    assert.doesNotThrow(() => state.assertAllowedTransition(
      kaType,
      StoreOnboardingStage.audit_rejected,
      StoreOnboardingStage.audit_preparing,
    ));
    assert.throws(() => state.assertAllowedTransition(
      kaType,
      StoreOnboardingStage.audit_rejected,
      StoreOnboardingStage.configuring,
    ), ConflictException);
  }
});

test('timeline separates shared Brand time from each batch own time', () => {
  const effort = calculateStoreOnboardingTimelineEffort({
    batchStartedAt: new Date('2026-08-21T00:05:00.000Z'),
    batchEndedAt: new Date('2026-08-21T00:13:00.000Z'),
    dependency: {
      startedAt: new Date('2026-08-21T00:00:00.000Z'),
      satisfiedAt: new Date('2026-08-21T00:10:00.000Z'),
      autoCompleted: false,
    },
  });

  assert.equal(effort.inclusiveLeadTimeMinutes, 13);
  assert.equal(effort.batchOwnTimeMinutes, 3);
  assert.equal(effort.ownStartedAt?.toISOString(), '2026-08-21T00:10:00.000Z');

  const waiting = calculateStoreOnboardingTimelineEffort({
    batchStartedAt: new Date('2026-08-21T00:05:00.000Z'),
    batchEndedAt: new Date('2026-08-21T00:13:00.000Z'),
    dependency: {
      startedAt: new Date('2026-08-21T00:00:00.000Z'),
      satisfiedAt: null,
      autoCompleted: false,
    },
  });
  assert.equal(waiting.batchOwnTimeMinutes, 0);
  assert.equal(waiting.ownStartedAt, null);
});

test('timeline attributes each interval to the stage opened by its transition and includes the current stage', () => {
  const openedAt = new Date('2026-08-21T00:10:00.000Z');
  const nextAt = new Date('2026-08-21T00:14:00.000Z');
  const historical = calculateStoreOnboardingStageInterval({
    openedAt,
    nextTransitionAt: nextAt,
    toStage: StoreOnboardingStage.configuring,
    currentStage: StoreOnboardingStage.awaiting_audit,
    now: new Date('2026-08-21T00:20:00.000Z'),
  });
  assert.equal(historical.startedAt, openedAt);
  assert.equal(historical.endedAt, nextAt);
  assert.equal(historical.durationMinutes, 4);
  assert.equal(historical.status, 'completed');

  const current = calculateStoreOnboardingStageInterval({
    openedAt: nextAt,
    nextTransitionAt: null,
    toStage: StoreOnboardingStage.awaiting_audit,
    currentStage: StoreOnboardingStage.awaiting_audit,
    now: new Date('2026-08-21T00:20:00.000Z'),
  });
  assert.equal(current.durationMinutes, 6);
  assert.equal(current.status, 'current');
});

const integrationUrl = process.env.STORE_ONBOARDING_TEST_DATABASE_URL;

test('fictional MX KA, CKA and SME scenarios run end-to-end without external calls', {
  skip: integrationUrl ? false : 'Set STORE_ONBOARDING_TEST_DATABASE_URL to run the PostgreSQL scenario suite',
  timeout: 120_000,
}, async t => {
  const prisma = new PrismaClient({ datasources: { db: { url: integrationUrl! } } });
  t.after(async () => prisma.$disconnect());

  const suffix = randomUUID().slice(0, 8);
  const section = await prisma.section.create({ data: { name: `Store Onboarding Test ${suffix}` } });
  manager.sectionId = section.id;
  owner.sectionId = section.id;
  commercial.sectionId = section.id;
  beverly.sectionId = section.id;
  outsider.sectionId = section.id;
  await prisma.account.createMany({ data: [
    { id: MANAGER_ID, name: 'Manager', email: `manager-${suffix}@example.com`, roles: [AccountRole.admin], sectionId: section.id },
    { id: OWNER_ID, name: 'Owner OP', email: `owner-${suffix}@example.com`, roles: [AccountRole.user], sectionId: section.id },
    { id: COMMERCIAL_ID, name: 'Commercial', email: `commercial-${suffix}@example.com`, roles: [AccountRole.user], sectionId: section.id },
    { id: BEVERLY_ID, name: 'Beverly', email: `beverly-${suffix}@example.com`, roles: [AccountRole.user], sectionId: section.id },
    { id: OUTSIDER_ID, name: 'Unassigned user', email: `outsider-${suffix}@example.com`, roles: [AccountRole.user], sectionId: section.id },
  ] });
  const [createType, brandType] = await Promise.all([
    prisma.taskType.create({ data: { sectionId: section.id, name: `Create stores ${suffix}` } }),
    prisma.taskType.create({ data: { sectionId: section.id, name: `Create brand ${suffix}` } }),
  ]);
  const application = await prisma.application.create({
    data: {
      appId: `app-${suffix}`,
      appName: `Test app ${suffix}`,
      appSecret: 'encrypted-test-only',
      country: Country.MX,
      createdById: MANAGER_ID,
    },
  });
  const boundary = new Date('2026-08-21T12:00:00.000Z');
  await prisma.storeOnboardingControl.create({
    data: {
      id: 'default',
      globalEnabled: true,
      notificationsEnabled: false,
      globalEnabledAt: boundary,
      activationConfirmedAt: boundary,
      updatedById: MANAGER_ID,
    },
  });

  const rollout = async (country: Country, kaType: KaType, brandTaskTypeId: string | null = null) => (
    prisma.storeOnboardingRolloutRevision.create({
      data: {
        country,
        kaType,
        revision: 1,
        enabled: true,
        effectiveAt: new Date(boundary.getTime() - 60_000),
        activatedAt: boundary,
        workflowVersion: `${kaType.toLowerCase()}-v1`,
        newRequestsOnly: true,
        timezone: 'America/Mexico_City',
        brandTaskTypeId,
        createdById: MANAGER_ID,
        sourceTaskTypes: { create: { source: StoreOnboardingSource.create, taskTypeId: createType.id } },
      },
    })
  );
  await Promise.all([rollout(Country.MX, KaType.KA), rollout(Country.MX, KaType.CKA), rollout(Country.MX, KaType.SME)]);

  const lifecycle = new StoreOnboardingLifecycleService(prisma as never);
  let gatewayCalls = 0;
  let remoteVerification: 'online' | 'offline' = 'online';
  let ambiguousNextOpen = false;
  let releaseOpen: (() => void) | null = null;
  let waitBeforeOpen: Promise<void> | null = null;
  const openedIdentities: Array<{ appId: string; appShopId: string }> = [];
  const verifiedIdentities: Array<{ appId: string; appShopId: string }> = [];
  const goLiveGateway = {
    prepare: async () => 'fictional-prepared-token',
    openAuthenticated: async (input: { appId: string; appShopId: string }) => {
      gatewayCalls++;
      openedIdentities.push({ appId: input.appId, appShopId: input.appShopId });
      if (waitBeforeOpen) await waitBeforeOpen;
      if (ambiguousNextOpen) {
        ambiguousNextOpen = false;
        throw new StoreOnboardingAmbiguousGoLiveError('setStatus may have succeeded; detail request failed');
      }
      return { endpoint: 'mock://setStatus+detail', remoteBizStatus: 1, response: { errno: 0 } };
    },
    verify: async (input: { appId: string; appShopId: string }) => {
      verifiedIdentities.push({ appId: input.appId, appShopId: input.appShopId });
      if (remoteVerification === 'offline') throw new StoreOnboardingRemoteOfflineError(2);
      return { endpoint: 'mock://detail', remoteBizStatus: 1, response: { verified: true } };
    },
  };
  const service = new StoreOnboardingService(
    prisma as never,
    { can: async (user: { id: string }) => user.id === MANAGER_ID } as never,
    lifecycle,
    goLiveGateway as never,
  );

  const createBrand = async (country: Country, kaType: KaType, label: string) => prisma.brand.create({
    data: {
      brandId: `${label}-${suffix}`,
      brandName: `${label} ${suffix}`,
      country,
      kaType,
      ownerId: OWNER_ID,
      applicationId: application.id,
      createdById: MANAGER_ID,
    },
  });
  const createStoreTask = async (brand: Awaited<ReturnType<typeof createBrand>>, createdAt: Date, withShop = true) => {
    const shop = withShop ? await prisma.shop.create({
      data: {
        shopId: `${brand.brandId}-shop-${randomUUID().slice(0, 6)}`,
        appShopId: `${brand.brandId}-app-${randomUUID().slice(0, 6)}`,
        brandId: brand.id,
        createdById: MANAGER_ID,
      },
    }) : null;
    const task = await prisma.task.create({
      data: { taskTypeId: createType.id, brandId: brand.id, createdById: MANAGER_ID, createdAt },
    });
    if (shop) await prisma.taskShop.create({ data: { taskId: task.id, shopId: shop.id } });
    const registration = await prisma.$transaction(tx => lifecycle.registerTaskAtCreation(tx, {
      taskId: task.id,
      taskTypeId: createType.id,
      createdAt,
      scheduledStart: null,
      createdById: MANAGER_ID,
      brand: { id: brand.id, country: brand.country, kaType: brand.kaType, createdAt: brand.createdAt },
    }));
    return { task, shop, registration };
  };
  const finishStoreTask = async (taskId: string) => {
    await prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.done } });
    await lifecycle.reconcileTaskAfterChange(taskId);
    await lifecycle.reconcileTaskAfterChange(taskId);
    return prisma.storeOnboardingRequest.findUniqueOrThrow({
      where: { taskId },
      include: { units: true, batches: true },
    });
  };

  await t.test('activation boundary and Brand-existing prerequisite are immutable/idempotent', async () => {
    const brand = await createBrand(Country.MX, KaType.KA, 'ka-boundary');
    const old = await createStoreTask(brand, new Date(boundary.getTime() - 1));
    assert.equal(old.registration.enrolled, false);
    assert.equal(await prisma.storeOnboardingRequest.count({ where: { taskId: old.task.id } }), 0);

    const current = await createStoreTask(brand, boundary);
    assert.equal(current.registration.enrolled, true);
    assert.equal(current.registration.blockedByBrand, false);
    const early = await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { taskId: current.task.id } });
    assert.equal(early.currentStage, StoreOnboardingStage.created);
    const hydrated = await finishStoreTask(current.task.id);
    assert.equal(hydrated.units.length, 1);
    assert.equal(hydrated.batches.length, 1);
    assert.equal(hydrated.units[0].stage, StoreOnboardingStage.awaiting_configuration_brief);
    assert.equal(await prisma.storeOnboardingUnit.count({ where: { requestId: hydrated.id } }), 1);
    const dependency = await prisma.taskDependency.findFirstOrThrow({ where: { taskId: current.task.id } });
    assert.equal(dependency.autoCompleted, true);
    assert.equal(dependency.startedAt.toISOString(), boundary.toISOString());
    assert.equal(dependency.satisfiedAt?.toISOString(), boundary.toISOString());
  });

  await t.test('enrollment keeps the KA workflow snapshot when the live Brand later changes to CKA', async () => {
    const brand = await createBrand(Country.MX, KaType.KA, 'ka-snapshot');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 500));
    assert.equal(created.registration.enrolled, true);

    await prisma.brand.update({ where: { id: brand.id }, data: { kaType: KaType.CKA } });
    const hydrated = await finishStoreTask(created.task.id);
    const enrollment = await prisma.storeOnboardingTaskEnrollment.findUniqueOrThrow({
      where: { taskId: created.task.id },
    });

    assert.equal(enrollment.kaTypeSnapshot, KaType.KA);
    assert.equal(enrollment.workflowVersion, 'ka-v1');
    assert.equal(hydrated.kaTypeSnapshot, KaType.KA);
    assert.equal(hydrated.workflowVersion, 'ka-v1');
    assert.equal(hydrated.units[0].stage, StoreOnboardingStage.awaiting_configuration_brief);
  });

  await t.test('archive cron never mutates or archives a Task owned by Store Onboarding', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'archive-protected');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 600));
    const definition = await prisma.stepDefinition.create({
      data: {
        taskTypeId: createType.id,
        name: `Archive protected step ${suffix}`,
        order: 99,
        executionType: ExecutionType.manual_internal,
        assignmentStrategy: AssignmentStrategy.manual,
      },
    });
    const step = await prisma.stepInstance.create({
      data: {
        taskId: created.task.id,
        stepDefinitionId: definition.id,
        status: StepStatus.in_progress,
      },
    });
    await prisma.task.update({
      where: { id: created.task.id },
      data: { createdAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    const beforeRequest = await prisma.storeOnboardingRequest.findUniqueOrThrow({
      where: { taskId: created.task.id },
      select: { id: true, status: true, currentStage: true },
    });
    const scheduler = new SchedulerService(prisma as never, {} as never, {} as never);
    await scheduler.archiveOldTasks(new Date('2021-01-01T00:00:00.000Z'));
    await scheduler.archiveOldTasks(new Date('2021-01-01T00:00:00.000Z'));

    const [protectedTask, protectedStep, protectedRequest, archiveCount] = await Promise.all([
      prisma.task.findUniqueOrThrow({ where: { id: created.task.id } }),
      prisma.stepInstance.findUniqueOrThrow({ where: { id: step.id } }),
      prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { id: beforeRequest.id } }),
      prisma.taskArchive.count({ where: { taskId: created.task.id } }),
    ]);
    assert.equal(protectedTask.status, TaskStatus.pending);
    assert.equal(protectedStep.status, StepStatus.in_progress);
    assert.equal(protectedRequest.status, beforeRequest.status);
    assert.equal(protectedRequest.currentStage, beforeRequest.currentStage);
    assert.equal(archiveCount, 0);
  });

  await t.test('Shop ID handoff requires both IDs and corrections are confined to awaiting_shop_ids', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'shop-id-handoff');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 750), false);
    const request = await finishStoreTask(created.task.id);
    assert.equal(request.currentStage, StoreOnboardingStage.awaiting_shop_ids);
    const localShop = await prisma.shop.create({
      data: {
        shopId: 'shop-handoff-1',
        appShopId: 'app-handoff-1',
        brandId: brand.id,
        createdById: MANAGER_ID,
      },
    });

    await assert.rejects(service.submitShopIds(request.id, {
      units: [{ externalShopId: 'shop-handoff-1', appShopId: '' }],
    }, owner), /requires a non-empty Shop ID and App Shop ID/);
    await assert.rejects(service.submitShopIds(request.id, {
      units: [{ shopId: localShop.id, externalShopId: 'shop-handoff-other', appShopId: 'app-handoff-1' }],
    }, owner), /does not match the submitted Shop ID/);
    await assert.rejects(service.submitShopIds(request.id, {
      units: [{ shopId: localShop.id, externalShopId: 'shop-handoff-1', appShopId: 'app-handoff-other' }],
    }, owner), /does not match the submitted App Shop ID/);
    assert.equal(
      (await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { id: request.id } })).currentStage,
      StoreOnboardingStage.awaiting_shop_ids,
    );
    assert.equal(await prisma.storeOnboardingUnit.count({ where: { requestId: request.id } }), 0);

    const payload = {
      units: [{ shopId: localShop.id, externalShopId: 'shop-handoff-1', appShopId: 'app-handoff-1' }],
    };
    let racedSubmission!: ReturnType<typeof service.submitShopIds>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      racedSubmission = service.submitShopIds(request.id, payload, owner);
      void racedSubmission.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
      // The preflight saw app-handoff-1. The authoritative in-transaction
      // Shop lock/refetch must see this concurrent identity change and abort.
      await tx.shop.update({
        where: { id: localShop.id },
        data: { appShopId: 'app-handoff-raced' },
      });
    });
    await assert.rejects(racedSubmission, /does not match the submitted App Shop ID/);
    assert.equal(await prisma.storeOnboardingUnit.count({ where: { requestId: request.id } }), 0);
    await prisma.shop.update({ where: { id: localShop.id }, data: { appShopId: 'app-handoff-1' } });

    let concurrentSubmissions: Array<ReturnType<typeof service.submitShopIds>> = [];
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      concurrentSubmissions = [
        service.submitShopIds(request.id, payload, owner),
        service.submitShopIds(request.id, payload, owner),
      ];
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    const settled = await Promise.allSettled(concurrentSubmissions);
    assert.equal(
      settled.filter(item => item.status === 'fulfilled').length,
      1,
      settled.map(item => item.status === 'rejected'
        ? String(item.reason instanceof Error ? item.reason.message : item.reason)
        : 'fulfilled').join(' | '),
    );
    const rejected = settled.find(item => item.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof ConflictException);
    assert.equal(
      (await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { id: request.id } })).currentStage,
      StoreOnboardingStage.audit_preparing,
    );
    assert.equal(await prisma.storeOnboardingUnit.count({ where: { requestId: request.id } }), 1);
    await assert.rejects(service.submitShopIds(request.id, {
      units: [{ shopId: localShop.id, externalShopId: 'shop-handoff-1', appShopId: 'app-handoff-correction' }],
    }, owner), /awaiting_shop_ids/);
  });

  await prisma.storeOnboardingControl.update({
    where: { id: 'default' },
    data: { notificationsEnabled: true, notificationsEnabledAt: new Date() },
  });

  await t.test('assignment and checklist notifications preserve A -> B -> A changes without duplicating retries', async () => {
    const kaBrand = await createBrand(Country.MX, KaType.KA, 'cyclic-assignment-events');
    const kaCreated = await createStoreTask(kaBrand, new Date(boundary.getTime() + 850));
    const kaRequest = await finishStoreTask(kaCreated.task.id);
    const kaUnit = kaRequest.units[0];

    await service.assignConfigurationBrief(kaRequest.id, { accountId: BEVERLY_ID }, manager);
    await service.assignConfigurationBrief(kaRequest.id, { accountId: OUTSIDER_ID }, manager);
    await service.assignConfigurationBrief(kaRequest.id, { accountId: BEVERLY_ID }, manager);
    await service.assignConfigurationBrief(kaRequest.id, { accountId: BEVERLY_ID }, manager);
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { eventKey: { startsWith: `request:${kaRequest.id}:brief-assignment:` } },
    }), 3);

    const assignmentA = {
      configurationAssigneeId: OWNER_ID,
      commercialAssigneeId: COMMERCIAL_ID,
      goLiveAssigneeId: OWNER_ID,
    };
    const assignmentB = {
      configurationAssigneeId: OUTSIDER_ID,
      commercialAssigneeId: OUTSIDER_ID,
      goLiveAssigneeId: OUTSIDER_ID,
    };
    await service.assignUnit(kaRequest.id, kaUnit.id, assignmentA, manager);
    await service.assignUnit(kaRequest.id, kaUnit.id, assignmentB, manager);
    await service.assignUnit(kaRequest.id, kaUnit.id, assignmentA, manager);
    await service.assignUnit(kaRequest.id, kaUnit.id, assignmentA, manager);
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { eventKey: { startsWith: `unit:${kaUnit.id}:assignment:` } },
    }), 3);

    const ckaBrand = await createBrand(Country.MX, KaType.CKA, 'cyclic-checklist-events');
    const ckaCreated = await createStoreTask(ckaBrand, new Date(boundary.getTime() + 900));
    const ckaRequest = await finishStoreTask(ckaCreated.task.id);
    const ckaUnit = ckaRequest.units[0];
    await service.transitionUnit(
      ckaRequest.id,
      ckaUnit.id,
      { stage: StoreOnboardingStage.awaiting_audit },
      manager,
    );
    await service.auditUnit(
      ckaRequest.id,
      ckaUnit.id,
      { decision: 'approved', note: 'Approved for cyclic checklist test' },
      manager,
    );
    const checklistA = { menu_ready: true };
    const checklistB = { menu_ready: false };
    await service.updateChecklist(ckaRequest.id, ckaUnit.id, { checklist: checklistA }, owner);
    await service.updateChecklist(ckaRequest.id, ckaUnit.id, { checklist: checklistB }, owner);
    await service.updateChecklist(ckaRequest.id, ckaUnit.id, { checklist: checklistA }, owner);
    await service.updateChecklist(ckaRequest.id, ckaUnit.id, { checklist: checklistA }, owner);
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { eventKey: { startsWith: `unit:${ckaUnit.id}:checklist:` } },
    }), 3);
  });

  await t.test('assignment targets are revalidated under lock after concurrent soft-delete or section changes', async () => {
    const briefTarget = await prisma.account.create({
      data: {
        name: 'Brief target race',
        email: `brief-target-race-${suffix}@example.com`,
        roles: [AccountRole.user],
        sectionId: section.id,
      },
    });
    const kaBrand = await createBrand(Country.MX, KaType.KA, 'brief-assignment-target-race');
    const kaCreated = await createStoreTask(kaBrand, new Date(boundary.getTime() + 925));
    const kaRequest = await finishStoreTask(kaCreated.task.id);
    let briefAssignment!: ReturnType<typeof service.assignConfigurationBrief>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${kaRequest.id}::uuid FOR UPDATE`;
      briefAssignment = service.assignConfigurationBrief(kaRequest.id, { accountId: briefTarget.id }, manager);
      void briefAssignment.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
      await tx.account.update({ where: { id: briefTarget.id }, data: { deletedAt: new Date() } });
    });
    await assert.rejects(briefAssignment, BadRequestException);
    assert.equal(
      (await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { id: kaRequest.id } }))
        .configurationBriefAssigneeId,
      null,
    );
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { eventKey: { startsWith: `request:${kaRequest.id}:brief-assignment:` } },
    }), 0);

    const movedTarget = await prisma.account.create({
      data: {
        name: 'Unit target race',
        email: `unit-target-race-${suffix}@example.com`,
        roles: [AccountRole.user],
        sectionId: section.id,
      },
    });
    const otherSection = await prisma.section.create({ data: { name: `Other assignment scope ${suffix}` } });
    const ckaBrand = await createBrand(Country.MX, KaType.CKA, 'unit-assignment-target-race');
    const ckaCreated = await createStoreTask(ckaBrand, new Date(boundary.getTime() + 950));
    const ckaRequest = await finishStoreTask(ckaCreated.task.id);
    const ckaUnit = ckaRequest.units[0];
    let unitAssignment!: ReturnType<typeof service.assignUnit>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${ckaRequest.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_unit" WHERE "id" = ${ckaUnit.id}::uuid FOR UPDATE`;
      unitAssignment = service.assignUnit(
        ckaRequest.id,
        ckaUnit.id,
        { commercialAssigneeId: movedTarget.id },
        manager,
      );
      void unitAssignment.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
      await tx.account.update({ where: { id: movedTarget.id }, data: { sectionId: otherSection.id } });
    });
    await assert.rejects(unitAssignment, BadRequestException);
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: ckaUnit.id } })).commercialAssigneeId,
      null,
    );
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { eventKey: { startsWith: `unit:${ckaUnit.id}:assignment:` } },
    }), 0);
  });

  await t.test('KA does brief, OP configuration, Commercial audit loops, RTBO and verified Go-Live', async () => {
    const brand = await createBrand(Country.MX, KaType.KA, 'ka-flow');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 1_000));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    const brief = { instructions: 'Configure this fictional KA store', fields: [], units: [] };
    await service.assignConfigurationBrief(request.id, { accountId: BEVERLY_ID }, manager);
    await service.updateConfigurationBrief(request.id, brief, beverly);
    await service.updateConfigurationBrief(request.id, brief, beverly);
    assert.equal(await prisma.storeOnboardingOutboxEvent.count({
      where: { requestId: request.id, eventType: 'configuration.brief_published' },
    }), 1);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.configuration_validated }, owner);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.audit_preparing }, manager);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
    await service.auditUnit(request.id, unit.id, {
      decision: 'needs_information', note: 'Provide a fictional document', evidence: ['ticket://123'],
    }, manager);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.audit_preparing }, manager);
    let refreshed = await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } });
    assert.equal(refreshed.blockedFromStage, null);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
    assert.equal((await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).auditStatus, StoreOnboardingAuditStatus.pending);
    await service.auditUnit(request.id, unit.id, { decision: 'rejected', note: 'Correct configuration' }, manager);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.configuring }, owner);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.configuration_validated }, owner);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.audit_preparing }, manager);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
    await service.auditUnit(request.id, unit.id, { decision: 'approved', note: 'Approved' }, manager);
    const checklist = {
      application_linked: true,
      credentials_valid: true,
      shop_list_verified: true,
      business_hours: true,
      picking_payment: true,
      driver_cash_block: true,
      menu_ready: true,
    };
    await assert.rejects(
      service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.rtbo }, manager),
      /RTBO requires every checklist item/,
    );
    await service.updateChecklist(request.id, unit.id, { checklist }, beverly);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.rtbo }, beverly);
    const result = await service.goLive(request.id, { unitIds: [unit.id] }, owner);
    assert.equal(result.succeeded, 1);
    refreshed = await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } });
    assert.equal(refreshed.stage, StoreOnboardingStage.online);
    assert.equal((await prisma.shop.findUniqueOrThrow({ where: { id: created.shop!.id } })).status, ShopStatus.online);
    assert.equal((await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'done');
    assert.ok((await prisma.storeOnboardingBatch.findFirstOrThrow({ where: { requestId: request.id } })).completedAt);
  });

  const runCommercialFlow = async (kaType: KaType) => {
    const brand = await createBrand(Country.MX, kaType, `${kaType.toLowerCase()}-flow`);
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_000));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    assert.equal(unit.stage, StoreOnboardingStage.audit_preparing);
    await service.assignUnit(request.id, unit.id, { commercialAssigneeId: COMMERCIAL_ID }, manager);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, commercial);
    await service.auditUnit(request.id, unit.id, { decision: 'rejected', note: 'Commercial correction' }, commercial);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.audit_preparing }, commercial);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, commercial);
    await service.auditUnit(request.id, unit.id, { decision: 'needs_information', note: 'More commercial data' }, commercial);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.audit_preparing }, commercial);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, commercial);
    await service.auditUnit(request.id, unit.id, { decision: 'approved', note: 'Approved' }, commercial);
    await service.updateChecklist(request.id, unit.id, {
      checklist: {
        application_linked: true,
        credentials_valid: true,
        shop_list_verified: true,
        business_hours: true,
        picking_payment: true,
        driver_cash_block: true,
        menu_ready: true,
      },
    }, owner);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.rtbo }, owner);
    await service.goLive(request.id, { unitIds: [unit.id] }, owner);
    return prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } });
  };

  await t.test('CKA and SME keep rejected correction with explicitly assigned Commercial', async () => {
    for (const kaType of [KaType.CKA, KaType.SME]) {
      const unit = await runCommercialFlow(kaType);
      assert.equal(unit.stage, StoreOnboardingStage.online);
      assert.equal(unit.auditStatus, StoreOnboardingAuditStatus.approved);
    }
  });

  await t.test('manual Go-Live rejects an identity change after auth, then retry and recovery use the fresh identity', async () => {
    const replacementApplication = await prisma.application.create({
      data: {
        appId: `replacement-app-${suffix}`,
        appName: `Replacement app ${suffix}`,
        appSecret: 'replacement-encrypted-test-only',
        country: Country.MX,
        createdById: MANAGER_ID,
      },
    });
    const checklist = {
      application_linked: true,
      credentials_valid: true,
      shop_list_verified: true,
      business_hours: true,
      picking_payment: true,
      driver_cash_block: true,
      menu_ready: true,
    };
    const prepareRtbo = async (label: string, createdAt: Date) => {
      const brand = await createBrand(Country.MX, KaType.CKA, label);
      const created = await createStoreTask(brand, createdAt);
      const request = await finishStoreTask(created.task.id);
      const unit = request.units[0];
      await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
      await service.auditUnit(request.id, unit.id, { decision: 'approved', note: 'Approved' }, manager);
      await service.updateChecklist(request.id, unit.id, { checklist }, owner);
      await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.rtbo }, owner);
      return { brand, created, request, unit };
    };

    const manual = await prepareRtbo('go-live-fresh-identity', new Date(boundary.getTime() + 2_250));
    const manualAppShopId = `manual-fresh-app-shop-${suffix}`;
    const originalAssertEnabled = lifecycle.assertEnabledInTransaction.bind(lifecycle);
    let assertionCalls = 0;
    let releaseSecondFence!: () => void;
    let secondFenceStarted!: () => void;
    const secondFence = new Promise<void>(resolve => { secondFenceStarted = resolve; });
    const secondFenceRelease = new Promise<void>(resolve => { releaseSecondFence = resolve; });
    lifecycle.assertEnabledInTransaction = async tx => {
      assertionCalls++;
      if (assertionCalls === 2) {
        secondFenceStarted();
        await secondFenceRelease;
      }
      return originalAssertEnabled(tx);
    };
    try {
      const opensBeforeIdentityChange = openedIdentities.length;
      const execution = service.goLive(manual.request.id, { unitIds: [manual.unit.id] }, owner);
      await secondFence;
      await prisma.$transaction([
        prisma.brand.update({ where: { id: manual.brand.id }, data: { applicationId: replacementApplication.id } }),
        prisma.storeOnboardingUnit.update({ where: { id: manual.unit.id }, data: { appShopId: manualAppShopId } }),
        prisma.shop.update({ where: { id: manual.created.shop!.id }, data: { appShopId: manualAppShopId } }),
      ]);
      releaseSecondFence();
      const result = await execution;
      assert.equal(result.succeeded, 0);
      assert.equal(result.failed, 1);
      assert.equal(openedIdentities.length, opensBeforeIdentityChange);

      const retry = await service.goLive(manual.request.id, { unitIds: [manual.unit.id] }, owner);
      assert.equal(retry.succeeded, 1);
      assert.deepEqual(openedIdentities.at(-1), {
        appId: replacementApplication.appId,
        appShopId: manualAppShopId,
      });
    } finally {
      lifecycle.assertEnabledInTransaction = originalAssertEnabled;
      releaseSecondFence();
    }

    const recovery = await prepareRtbo('recovery-fresh-identity', new Date(boundary.getTime() + 2_375));
    await prisma.storeOnboardingUnit.update({
      where: { id: recovery.unit.id },
      data: { stage: StoreOnboardingStage.going_online },
    });
    await prisma.storeOnboardingGoLiveAttempt.create({
      data: {
        unitId: recovery.unit.id,
        source: 'manual',
        actorId: OWNER_ID,
        startedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    const recoveryAppShopId = `recovery-fresh-app-shop-${suffix}`;
    assertionCalls = 0;
    let releaseRecoveryFence!: () => void;
    let recoveryFenceStarted!: () => void;
    const recoveryFence = new Promise<void>(resolve => { recoveryFenceStarted = resolve; });
    const recoveryFenceRelease = new Promise<void>(resolve => { releaseRecoveryFence = resolve; });
    lifecycle.assertEnabledInTransaction = async tx => {
      assertionCalls++;
      if (assertionCalls === 1) {
        recoveryFenceStarted();
        await recoveryFenceRelease;
      }
      return originalAssertEnabled(tx);
    };
    try {
      const recovering = service.recoverGoingOnlineAttempts();
      await recoveryFence;
      await prisma.$transaction([
        prisma.brand.update({ where: { id: recovery.brand.id }, data: { applicationId: replacementApplication.id } }),
        prisma.storeOnboardingUnit.update({ where: { id: recovery.unit.id }, data: { appShopId: recoveryAppShopId } }),
        prisma.shop.update({ where: { id: recovery.created.shop!.id }, data: { appShopId: recoveryAppShopId } }),
      ]);
      releaseRecoveryFence();
      await recovering;
      assert.deepEqual(verifiedIdentities.at(-1), {
        appId: replacementApplication.appId,
        appShopId: recoveryAppShopId,
      });
      assert.equal(
        (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: recovery.unit.id } })).stage,
        StoreOnboardingStage.online,
      );
    } finally {
      lifecycle.assertEnabledInTransaction = originalAssertEnabled;
      releaseRecoveryFence();
    }
  });

  await t.test('request visibility and Commercial actions are limited to explicit assignment', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'commercial-scope');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_500));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await service.assignUnit(request.id, unit.id, { commercialAssigneeId: COMMERCIAL_ID }, manager);

    await assert.rejects(service.findOne(request.id, outsider), NotFoundException);
    await assert.rejects(
      service.transitionUnit(
        request.id,
        unit.id,
        { stage: StoreOnboardingStage.awaiting_audit },
        outsider,
      ),
      NotFoundException,
    );
    await assert.rejects(
      service.submitShopIds(request.id, { units: [] }, outsider),
      NotFoundException,
    );
    await assert.rejects(
      service.goLive(request.id, { unitIds: [randomUUID()] }, outsider),
      NotFoundException,
    );
    await assert.rejects(
      service.updateConfigurationBrief(request.id, {
        instructions: 'Must not reveal whether this is a KA request',
      }, outsider),
      NotFoundException,
    );
    await assert.rejects(
      service.updateChecklist(request.id, randomUUID(), { checklist: {} }, outsider),
      NotFoundException,
    );
    await assert.rejects(
      service.auditUnit(request.id, randomUUID(), { decision: 'approved' }, outsider),
      NotFoundException,
    );
    const visible = await service.findOne(request.id, commercial);
    assert.equal(visible.id, request.id);
    await service.transitionUnit(
      request.id,
      unit.id,
      { stage: StoreOnboardingStage.awaiting_audit },
      commercial,
    );
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.awaiting_audit,
    );
  });

  await t.test('forecast recalculation locks and projects the fresh Unit stage', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'forecast-race');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_600));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    let recalculation!: ReturnType<typeof service.recalculateForecast>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      recalculation = service.recalculateForecast(request.id, manager);
      void recalculation.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
      await tx.storeOnboardingUnit.update({
        where: { id: unit.id },
        data: { stage: StoreOnboardingStage.online, onlineAt: new Date() },
      });
    });
    const snapshot = await recalculation;
    assert.equal(snapshot.queueUnits, 0);
    assert.equal(snapshot.confidence, 'high');
  });

  await t.test('a Commercial reassignment committed before the transition claim revokes the stale actor', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'commercial-race');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_700));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await service.assignUnit(request.id, unit.id, { commercialAssigneeId: COMMERCIAL_ID }, manager);

    let staleTransition!: ReturnType<typeof service.transitionUnit>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_unit" WHERE "id" = ${unit.id}::uuid FOR UPDATE`;
      staleTransition = service.transitionUnit(
        request.id,
        unit.id,
        { stage: StoreOnboardingStage.awaiting_audit },
        commercial,
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      await tx.storeOnboardingUnit.update({
        where: { id: unit.id },
        data: { commercialAssigneeId: OUTSIDER_ID },
      });
    });

    await assert.rejects(staleTransition, NotFoundException);
    const fresh = await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } });
    assert.equal(fresh.stage, StoreOnboardingStage.audit_preparing);
    assert.equal(fresh.commercialAssigneeId, OUTSIDER_ID);
  });

  await t.test('RTBO wins a concurrent checklist autosave and keeps the approved checklist immutable', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'checklist-race');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_800));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
    await service.auditUnit(request.id, unit.id, { decision: 'approved', note: 'Approved' }, manager);
    const completeChecklist = {
      application_linked: true,
      credentials_valid: true,
      shop_list_verified: true,
      business_hours: true,
      picking_payment: true,
      driver_cash_block: true,
      menu_ready: true,
    };
    await service.updateChecklist(request.id, unit.id, { checklist: completeChecklist }, owner);

    let rtboTransition!: ReturnType<typeof service.transitionUnit>;
    let staleAutosave!: ReturnType<typeof service.updateChecklist>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_unit" WHERE "id" = ${unit.id}::uuid FOR UPDATE`;
      rtboTransition = service.transitionUnit(
        request.id,
        unit.id,
        { stage: StoreOnboardingStage.rtbo },
        owner,
      );
      await new Promise(resolve => setTimeout(resolve, 75));
      staleAutosave = service.updateChecklist(request.id, unit.id, {
        checklist: { ...completeChecklist, menu_ready: false },
      }, owner);
      void staleAutosave.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
    });

    await rtboTransition;
    await assert.rejects(staleAutosave, /only be edited after Audit approval/);
    const fresh = await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } });
    assert.equal(fresh.stage, StoreOnboardingStage.rtbo);
    assert.equal((fresh.checklist as Record<string, boolean>).menu_ready, true);
  });

  await t.test('timeline pagination keeps same-timestamp transition order and includes the current stage interval', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'timeline-order');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 2_900));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    // Keep the synthetic tie strictly after hydration transitions regardless
    // of the wall-clock time at which the suite runs.
    const occurredAt = new Date(Date.now() + 60_000);
    const firstId = '50000000-0000-4000-8000-000000000001';
    const secondId = '50000000-0000-4000-8000-000000000002';
    await prisma.storeOnboardingTransition.createMany({ data: [
      {
        id: firstId,
        unitId: unit.id,
        fromStage: StoreOnboardingStage.audit_preparing,
        toStage: StoreOnboardingStage.awaiting_audit,
        createdAt: occurredAt,
      },
      {
        id: secondId,
        unitId: unit.id,
        fromStage: StoreOnboardingStage.awaiting_audit,
        toStage: StoreOnboardingStage.audit_approved,
        createdAt: occurredAt,
      },
    ] });
    await prisma.storeOnboardingUnit.update({
      where: { id: unit.id },
      data: { stage: StoreOnboardingStage.audit_approved },
    });

    const page = await lifecycle.timeline(request.id, { page: 2, limit: 2, unitId: unit.id });
    const segments = page.data as Array<{
      eventId: string | null;
      stage?: string;
      startedAt: Date;
      endedAt: Date | null;
      status: string;
      durationMinutes: number;
    }>;
    assert.deepEqual(segments.map(segment => segment.eventId), [firstId, secondId]);
    assert.equal(segments[0].stage, StoreOnboardingStage.awaiting_audit);
    assert.equal(segments[0].startedAt.toISOString(), occurredAt.toISOString());
    assert.equal(segments[0].endedAt?.toISOString(), occurredAt.toISOString());
    assert.equal(segments[0].status, 'completed');
    assert.equal(segments[1].stage, StoreOnboardingStage.audit_approved);
    assert.equal(segments[1].status, 'current');
    assert.ok(segments[1].durationMinutes >= 0);
  });

  await t.test('Brand Task is a visible shared prerequisite and unblocks every enrolled batch once', async () => {
    await rollout(Country.CO, KaType.KA, brandType.id);
    const brand = await createBrand(Country.CO, KaType.KA, 'brand-prerequisite');
    const brandTask = await prisma.task.create({
      data: { taskTypeId: brandType.id, brandId: brand.id, createdById: MANAGER_ID, createdAt: boundary },
    });
    const first = await createStoreTask(brand, new Date(boundary.getTime() + 3_000), false);
    assert.equal(first.registration.blockedByBrand, true);
    assert.equal((await prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { taskId: first.task.id } })).currentStage, StoreOnboardingStage.blocked);
    await prisma.task.update({ where: { id: brandTask.id }, data: { status: TaskStatus.done } });
    // Simulate a process crash after the Task terminal commit: no direct
    // afterTerminalTask hook runs. The bounded recovery scan must release it.
    const released = await lifecycle.recoverTerminalBrandProvisionings();
    assert.deepEqual(released, [first.task.id]);
    assert.deepEqual(await lifecycle.recoverTerminalBrandProvisionings(), []);
    await prisma.task.update({ where: { id: first.task.id }, data: { status: TaskStatus.done } });
    await lifecycle.reconcileTaskAfterChange(first.task.id);
    const second = await createStoreTask(brand, new Date(boundary.getTime() + 4_000), false);
    await prisma.task.update({ where: { id: second.task.id }, data: { status: TaskStatus.done } });
    const secondRequest = await lifecycle.reconcileTaskAfterChange(second.task.id);
    const timeline = await lifecycle.timeline(secondRequest.requestId!, {});
    assert.equal(timeline.summary.brandDependency?.sharedBatchCount, 2);
    assert.equal(timeline.summary.brandDependency?.autoCompleted, false);
    assert.ok(timeline.data.some(segment => segment.type === 'task_created'));
  });

  await t.test('a failed Brand prerequisite adopts a later retry and releases existing dependencies once', async () => {
    const brand = await createBrand(Country.CO, KaType.KA, 'brand-retry');
    const failedBrandTask = await prisma.task.create({
      data: {
        taskTypeId: brandType.id,
        brandId: brand.id,
        createdById: MANAGER_ID,
        createdAt: new Date(boundary.getTime() + 5_000),
      },
    });
    const store = await createStoreTask(brand, new Date(boundary.getTime() + 6_000), false);
    assert.equal(store.registration.blockedByBrand, true);
    await prisma.task.update({ where: { id: failedBrandTask.id }, data: { status: TaskStatus.failed } });
    await lifecycle.reconcileTaskAfterChange(failedBrandTask.id);
    assert.equal((await prisma.taskDependency.findFirstOrThrow({ where: { taskId: store.task.id } })).status, 'failed');

    const retryBrandTask = await prisma.task.create({
      data: {
        taskTypeId: brandType.id,
        brandId: brand.id,
        createdById: MANAGER_ID,
        status: TaskStatus.done,
        createdAt: new Date(boundary.getTime() + 7_000),
      },
    });
    const released = await lifecycle.recoverTerminalBrandProvisionings();
    assert.deepEqual(released, [store.task.id]);
    const [provisioning, dependency, request] = await Promise.all([
      prisma.brandProvisioning.findUniqueOrThrow({ where: { brandId: brand.id } }),
      prisma.taskDependency.findFirstOrThrow({ where: { taskId: store.task.id } }),
      prisma.storeOnboardingRequest.findUniqueOrThrow({ where: { taskId: store.task.id } }),
    ]);
    assert.equal(provisioning.sourceTaskId, retryBrandTask.id);
    assert.equal(provisioning.status, 'ready');
    assert.equal(dependency.status, 'satisfied');
    assert.equal(dependency.prerequisiteTaskId, retryBrandTask.id);
    assert.equal(request.currentStage, StoreOnboardingStage.created);
    assert.equal(await prisma.taskDependency.count({ where: { taskId: store.task.id } }), 1);
  });

  await t.test('a fenced Go-Live gap recovers offline to retryable failure without repeating the remote write', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'go-live-recovery');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 8_000));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await prisma.storeOnboardingUnit.update({
      where: { id: unit.id },
      data: { stage: StoreOnboardingStage.going_online, rtboAt: new Date() },
    });
    const attempt = await prisma.storeOnboardingGoLiveAttempt.create({
      data: {
        unitId: unit.id,
        source: 'manual',
        actorId: OWNER_ID,
        startedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    const writesBeforeRecovery = gatewayCalls;
    remoteVerification = 'offline';
    await service.recoverGoingOnlineAttempts();
    assert.equal(gatewayCalls, writesBeforeRecovery);
    assert.equal((await prisma.storeOnboardingGoLiveAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, 'failed');
    assert.equal((await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage, StoreOnboardingStage.online_failed);

    remoteVerification = 'online';
    const retry = await service.goLive(request.id, { unitIds: [unit.id] }, owner);
    assert.equal(retry.succeeded, 1);
    assert.equal((await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage, StoreOnboardingStage.online);
    const transitions = await prisma.storeOnboardingTransition.findMany({
      where: { unitId: unit.id },
      orderBy: { createdAt: 'asc' },
      select: { toStage: true },
    });
    assert.ok(transitions.some(item => item.toStage === StoreOnboardingStage.awaiting_go_live));
    assert.ok(transitions.some(item => item.toStage === StoreOnboardingStage.going_online));
  });

  await t.test('ambiguous post-write Go-Live remains pending and recovery verifies without a second POST', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'go-live-ambiguous');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 8_100));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await prisma.storeOnboardingUnit.update({
      where: { id: unit.id },
      data: { stage: StoreOnboardingStage.rtbo, rtboAt: new Date() },
    });

    ambiguousNextOpen = true;
    const writesBefore = gatewayCalls;
    const result = await service.goLive(request.id, { unitIds: [unit.id] }, owner);
    assert.equal(gatewayCalls, writesBefore + 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].status, 'verification_pending');
    const runningAttempt = await prisma.storeOnboardingGoLiveAttempt.findFirstOrThrow({
      where: { unitId: unit.id, status: 'running' },
      orderBy: { startedAt: 'desc' },
    });
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.going_online,
    );
    await prisma.storeOnboardingGoLiveAttempt.update({
      where: { id: runningAttempt.id },
      data: { startedAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    const writesBeforeRecovery = gatewayCalls;
    remoteVerification = 'online';
    await service.recoverGoingOnlineAttempts();
    assert.equal(gatewayCalls, writesBeforeRecovery);
    assert.equal(
      (await prisma.storeOnboardingGoLiveAttempt.findUniqueOrThrow({ where: { id: runningAttempt.id } })).status,
      'done',
    );
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.online,
    );
  });

  await t.test('failed Go-Live finalization locks fresh state and revokes a stale actor', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'go-live-failure-lock');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 8_150));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await prisma.storeOnboardingUnit.update({
      where: { id: unit.id },
      data: { stage: StoreOnboardingStage.going_online, rtboAt: new Date() },
    });
    const attempt = await prisma.storeOnboardingGoLiveAttempt.create({
      data: { unitId: unit.id, source: 'manual', actorId: OWNER_ID },
    });
    const internal = service as unknown as {
      finishFailedGoLive(
        requestId: string,
        unitId: string,
        user: typeof owner | typeof manager,
        error: string,
        attemptId: string,
      ): Promise<{ status: string }>;
    };

    let staleFinalization!: ReturnType<typeof internal.finishFailedGoLive>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${request.id}::uuid FOR UPDATE`;
      staleFinalization = internal.finishFailedGoLive(
        request.id,
        unit.id,
        owner,
        'explicit remote rejection',
        attempt.id,
      );
      void staleFinalization.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 75));
      await tx.brand.update({ where: { id: brand.id }, data: { ownerId: OUTSIDER_ID } });
      await tx.storeOnboardingUnit.update({
        where: { id: unit.id },
        data: {
          configurationAssigneeId: null,
          commercialAssigneeId: null,
          goLiveAssigneeId: null,
        },
      });
    });
    await assert.rejects(staleFinalization, NotFoundException);
    assert.equal(
      (await prisma.storeOnboardingGoLiveAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'running',
    );
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.going_online,
    );

    const finalized = await internal.finishFailedGoLive(
      request.id,
      unit.id,
      manager,
      'explicit remote rejection',
      attempt.id,
    );
    assert.equal(finalized.status, 'online_failed');
    assert.equal(
      (await prisma.storeOnboardingGoLiveAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'failed',
    );
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.online_failed,
    );
  });

  await t.test('external reconciliation never competes with a live manual Go-Live attempt', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'go-live-concurrency');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 8_250));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.awaiting_audit }, manager);
    await service.auditUnit(request.id, unit.id, { decision: 'approved', note: 'Approved' }, manager);
    const checklist = {
      application_linked: true,
      credentials_valid: true,
      shop_list_verified: true,
      business_hours: true,
      picking_payment: true,
      driver_cash_block: true,
      menu_ready: true,
    };
    await service.updateChecklist(request.id, unit.id, { checklist }, owner);
    await service.transitionUnit(request.id, unit.id, { stage: StoreOnboardingStage.rtbo }, owner);

    waitBeforeOpen = new Promise<void>(resolve => { releaseOpen = resolve; });
    const manual = service.goLive(request.id, { unitIds: [unit.id] }, owner);
    for (let index = 0; index < 50; index++) {
      if ((await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage === StoreOnboardingStage.going_online) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(
      (await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage,
      StoreOnboardingStage.going_online,
    );
    assert.deepEqual(await service.reconcileOnline(created.shop!.id, 'auto_open' as never), { changed: 0 });
    releaseOpen?.();
    const result = await manual;
    waitBeforeOpen = null;
    releaseOpen = null;

    assert.equal(result.succeeded, 1);
    assert.equal(await prisma.storeOnboardingGoLiveAttempt.count({
      where: { unitId: unit.id, status: 'running' },
    }), 0);
    assert.equal((await prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } })).stage, StoreOnboardingStage.online);
  });

  await t.test('stale Go-Live recovery without App Shop ID fails locally and never calls the gateway', async () => {
    const brand = await createBrand(Country.MX, KaType.CKA, 'go-live-missing-id');
    const created = await createStoreTask(brand, new Date(boundary.getTime() + 8_500));
    const request = await finishStoreTask(created.task.id);
    const unit = request.units[0];
    await prisma.storeOnboardingUnit.update({
      where: { id: unit.id },
      data: { stage: StoreOnboardingStage.going_online, rtboAt: new Date(), appShopId: null },
    });
    const attempt = await prisma.storeOnboardingGoLiveAttempt.create({
      data: {
        unitId: unit.id,
        source: 'manual',
        actorId: OWNER_ID,
        startedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    const writesBeforeRecovery = gatewayCalls;
    await service.recoverGoingOnlineAttempts();
    assert.equal(gatewayCalls, writesBeforeRecovery);
    const [failedAttempt, failedUnit] = await Promise.all([
      prisma.storeOnboardingGoLiveAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      prisma.storeOnboardingUnit.findUniqueOrThrow({ where: { id: unit.id } }),
    ]);
    assert.equal(failedAttempt.status, 'failed');
    assert.match(failedAttempt.error ?? '', /App Shop ID/);
    assert.equal(failedUnit.stage, StoreOnboardingStage.online_failed);
  });

  await t.test('TaskEngine fences enrolled mutations, claims concurrency once and recovers only after reactivation', async () => {
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: { notificationsEnabled: false, notificationsEnabledAt: null },
    });
    const handler = await prisma.handler.create({
      data: { name: `Store Onboarding engine handler ${suffix}` },
    });
    const [automaticDefinition, manualDefinition] = await Promise.all([
      prisma.stepDefinition.create({
        data: {
          taskTypeId: createType.id,
          name: `Automatic claim ${suffix}`,
          order: 100,
          executionType: ExecutionType.automatic,
          assignmentStrategy: AssignmentStrategy.manual,
          handlerId: handler.id,
        },
      }),
      prisma.stepDefinition.create({
        data: {
          taskTypeId: createType.id,
          name: `Manual claim ${suffix}`,
          order: 101,
          executionType: ExecutionType.manual_internal,
          assignmentStrategy: AssignmentStrategy.manual,
        },
      }),
    ]);
    const engineBrand = await createBrand(Country.MX, KaType.KA, 'task-engine-fences');
    let offset = 8_700;
    const enrolledTask = async (status: TaskStatus) => {
      offset += 10;
      const created = await createStoreTask(engineBrand, new Date(boundary.getTime() + offset));
      assert.equal(created.registration.enrolled, true);
      return prisma.task.update({ where: { id: created.task.id }, data: { status } });
    };
    let webhookCalls = 0;
    let queuedJobs = 0;
    const liveOriginalJobs = new Set<string>();
    const recoveryJobIds = new Set<string>();
    const engine = new TaskEngineService(prisma as never, {} as never, lifecycle);
    (engine as unknown as { sendStepWebhook: () => Promise<void> }).sendStepWebhook = async () => {
      webhookCalls++;
    };
    engine.emitAutoStep = stepInstanceId => {
      queuedJobs++;
      liveOriginalJobs.add(stepInstanceId);
    };
    engine.recoverAutoStepJob = async (
      stepInstanceId,
      _handlerId,
      _taskId,
      activationEpoch,
      executionGeneration,
    ) => {
      if (liveOriginalJobs.has(stepInstanceId)) return false;
      const jobId = `${stepInstanceId}-onboarding-recovery-${activationEpoch}-${executionGeneration}`;
      if (recoveryJobIds.has(jobId)) return false;
      recoveryJobIds.add(jobId);
      return true;
    };

    const scheduledTask = await enrolledTask(TaskStatus.scheduled);
    const scheduledStep = await prisma.stepInstance.create({
      data: {
        taskId: scheduledTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.pending,
      },
    });
    const activationClaims = await Promise.all([
      engine.activateStep(scheduledStep.id, TaskStatus.scheduled),
      engine.activateStep(scheduledStep.id, TaskStatus.scheduled),
    ]);
    for (const claimed of activationClaims) {
      if (claimed) engine.emitAutoStep(scheduledStep.id, automaticDefinition.handlerId!, scheduledTask.id);
    }
    assert.equal(activationClaims.filter(Boolean).length, 1);
    assert.equal(queuedJobs, 1);
    assert.equal(webhookCalls, 1);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: scheduledStep.id } })).status,
      StepStatus.in_progress,
    );

    const gatedTask = await enrolledTask(TaskStatus.in_progress);
    const gatedSteps = await Promise.all([
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.pending,
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.blocked,
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.failed,
      } }),
      prisma.stepInstance.create({ data: {
        taskId: gatedTask.id,
        stepDefinitionId: manualDefinition.id,
        status: StepStatus.pending,
      } }),
    ]);
    const staleHandlerTask = await enrolledTask(TaskStatus.in_progress);
    const staleHandlerStep = await prisma.stepInstance.create({
      data: {
        taskId: staleHandlerTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      },
    });
    const recoverableTask = await enrolledTask(TaskStatus.pending);
    const recoverableStep = await prisma.stepInstance.create({
      data: {
        taskId: recoverableTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.pending,
      },
    });
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: { globalEnabled: false, notificationsEnabled: false },
    });
    const blockedOperations = [
      engine.startStep(gatedSteps[0].id),
      engine.completeStep(gatedSteps[1].id),
      engine.failStep(gatedSteps[2].id, StepFailureReason.error_handler),
      engine.blockStep(gatedSteps[3].id),
      engine.retryStep(gatedSteps[4].id),
      engine.forceRetryStep(gatedSteps[5].id),
      engine.assignOrReassignStep(gatedSteps[6].id, OWNER_ID),
    ];
    for (const operation of blockedOperations) void operation.catch(() => undefined);
    const blockedResults = await Promise.allSettled(blockedOperations);
    assert.equal(blockedResults.every(result => (
      result.status === 'rejected' && result.reason instanceof ConflictException
    )), true);
    let staleEffectCalls = 0;
    assert.equal(await engine.runAutomaticHandlerUnderFence(
      staleHandlerStep.id,
      staleHandlerTask.id,
      async () => {
        staleEffectCalls++;
        return { status: 'completed' as const };
      },
    ), false);
    assert.equal(staleEffectCalls, 0);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: staleHandlerStep.id } })).status,
      StepStatus.in_progress,
    );

    // A Task with no enrollment remains legacy-transparent even while the
    // Store Onboarding master is OFF.
    const legacyTask = await prisma.task.create({
      data: { taskTypeId: createType.id, createdById: MANAGER_ID, status: TaskStatus.in_progress },
    });
    const legacyStep = await prisma.stepInstance.create({
      data: {
        taskId: legacyTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      },
    });
    let legacyEffects = 0;
    const legacyExecuted = await engine.runAutomaticHandlerUnderFence(
      legacyStep.id,
      legacyTask.id,
      async () => {
        legacyEffects++;
        return { status: 'completed' as const, result: { legacy: true } };
      },
    );
    assert.equal(legacyExecuted, true);
    assert.equal(legacyEffects, 1);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: legacyStep.id } })).status,
      StepStatus.done,
    );

    await prisma.stepInstance.updateMany({
      where: { taskId: gatedTask.id },
      data: { status: StepStatus.cancelled },
    });
    await prisma.task.update({ where: { id: gatedTask.id }, data: { status: TaskStatus.failed } });
    await engine.advanceTask(recoverableTask.id);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: recoverableStep.id } })).status,
      StepStatus.pending,
    );
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: {
        globalEnabled: true,
        notificationsEnabled: false,
        globalEnabledAt: new Date(boundary.getTime() + 1),
      },
    });
    const queuedBeforeRecovery = queuedJobs;
    await engine.recoverStoreOnboardingBrandTasks();
    await engine.recoverStoreOnboardingBrandTasks();
    assert.equal(queuedJobs - queuedBeforeRecovery, 1);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: recoverableStep.id } })).status,
      StepStatus.in_progress,
    );
    assert.deepEqual([...recoveryJobIds], [
      `${staleHandlerStep.id}-onboarding-recovery-${boundary.getTime() + 1}-${staleHandlerStep.startedAt!.getTime()}`,
    ]);

    // The first recovery job is consumed while OFF and remains retained by
    // Bull. A second ON epoch must emit a distinct job for the same Step.
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: { globalEnabled: false, notificationsEnabled: false, globalEnabledAt: null },
    });
    assert.equal(await engine.runAutomaticHandlerUnderFence(
      staleHandlerStep.id,
      staleHandlerTask.id,
      async () => {
        staleEffectCalls++;
        return { status: 'completed' as const };
      },
    ), false);
    assert.equal(staleEffectCalls, 0);
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: {
        globalEnabled: true,
        notificationsEnabled: false,
        globalEnabledAt: new Date(boundary.getTime() + 2),
      },
    });
    await engine.recoverStoreOnboardingBrandTasks();
    await engine.recoverStoreOnboardingBrandTasks();
    assert.deepEqual([...recoveryJobIds], [
      `${staleHandlerStep.id}-onboarding-recovery-${boundary.getTime() + 1}-${staleHandlerStep.startedAt!.getTime()}`,
      `${staleHandlerStep.id}-onboarding-recovery-${boundary.getTime() + 2}-${staleHandlerStep.startedAt!.getTime()}`,
    ]);

    engine.advanceTask = async () => undefined;
    assert.equal(await engine.runAutomaticHandlerUnderFence(
      staleHandlerStep.id,
      staleHandlerTask.id,
      async () => {
        staleEffectCalls++;
        return { status: 'completed' as const };
      },
    ), true);
    assert.equal(staleEffectCalls, 1);
    await engine.recoverStoreOnboardingBrandTasks();
    assert.equal(recoveryJobIds.size, 2, 'a terminal Step is no longer a recovery candidate');

    const forceRetryTask = await enrolledTask(TaskStatus.failed);
    const failedExecutionStartedAt = new Date('2020-01-01T00:00:00.000Z');
    const forceRetryStep = await prisma.stepInstance.create({
      data: {
        taskId: forceRetryTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.failed,
        failureReason: StepFailureReason.error_handler,
        startedAt: failedExecutionStartedAt,
        completedAt: new Date(),
      },
    });
    recoveryJobIds.add(
      `${forceRetryStep.id}-onboarding-recovery-${boundary.getTime() + 2}-${failedExecutionStartedAt.getTime()}`,
    );
    const recoveryCountBeforeForceRetry = recoveryJobIds.size;
    await engine.forceRetryStep(forceRetryStep.id);
    const retriedStep = await prisma.stepInstance.findUniqueOrThrow({ where: { id: forceRetryStep.id } });
    assert.equal(retriedStep.status, StepStatus.in_progress);
    assert.notEqual(retriedStep.startedAt!.getTime(), failedExecutionStartedAt.getTime());
    await engine.recoverStoreOnboardingBrandTasks();
    await engine.recoverStoreOnboardingBrandTasks();
    assert.equal(recoveryJobIds.size, recoveryCountBeforeForceRetry + 1);
    assert.ok(recoveryJobIds.has(
      `${forceRetryStep.id}-onboarding-recovery-${boundary.getTime() + 2}-${retriedStep.startedAt!.getTime()}`,
    ));
    let retriedEffectCalls = 0;
    assert.equal(await engine.runAutomaticHandlerUnderFence(
      forceRetryStep.id,
      forceRetryTask.id,
      async () => {
        retriedEffectCalls++;
        return { status: 'completed' as const };
      },
    ), true);
    assert.equal(retriedEffectCalls, 1);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: forceRetryStep.id } })).status,
      StepStatus.done,
    );

    const raceEngine = new TaskEngineService(prisma as never, {} as never, lifecycle);
    let terminalWebhooks = 0;
    (raceEngine as unknown as { sendStepWebhook: () => Promise<void> }).sendStepWebhook = async () => {
      terminalWebhooks++;
    };
    raceEngine.advanceTask = async () => undefined;
    (raceEngine as unknown as { afterTerminalTask: () => Promise<void> }).afterTerminalTask = async () => undefined;

    const terminalTask = await enrolledTask(TaskStatus.in_progress);
    const terminalStep = await prisma.stepInstance.create({
      data: {
        taskId: terminalTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      },
    });
    const terminalRace = await Promise.allSettled([
      raceEngine.completeStep(terminalStep.id, { winner: 'complete' }),
      raceEngine.failStep(terminalStep.id, StepFailureReason.error_handler),
    ]);
    assert.equal(terminalRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(terminalRace.filter(result => result.status === 'rejected').length, 1);
    assert.ok(new Set<StepStatus>([
      StepStatus.done,
      StepStatus.failed,
    ]).has((await prisma.stepInstance.findUniqueOrThrow({ where: { id: terminalStep.id } })).status));
    assert.equal(terminalWebhooks, 1);

    const handlerTask = await enrolledTask(TaskStatus.in_progress);
    const handlerStep = await prisma.stepInstance.create({
      data: {
        taskId: handlerTask.id,
        stepDefinitionId: automaticDefinition.id,
        status: StepStatus.in_progress,
        startedAt: new Date(),
      },
    });
    let releaseEffect!: () => void;
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>(resolve => { markEffectStarted = resolve; });
    const effectRelease = new Promise<void>(resolve => { releaseEffect = resolve; });
    const runningHandler = raceEngine.runAutomaticHandlerUnderFence(
      handlerStep.id,
      handlerTask.id,
      async () => {
        markEffectStarted();
        await effectRelease;
        return { status: 'completed' as const };
      },
    );
    await effectStarted;
    let timeoutSettled = false;
    const concurrentTimeout = raceEngine
      .failStep(handlerStep.id, StepFailureReason.system_timed_out)
      .finally(() => { timeoutSettled = true; });
    void concurrentTimeout.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(timeoutSettled, false);
    releaseEffect();
    assert.equal(await runningHandler, true);
    await assert.rejects(concurrentTimeout, /Step must be active to be failed/);
    assert.equal(
      (await prisma.stepInstance.findUniqueOrThrow({ where: { id: handlerStep.id } })).status,
      StepStatus.done,
    );
    assert.equal(await prisma.stepInstance.count({
      where: { id: handlerStep.id, status: { in: [StepStatus.done, StepStatus.failed] } },
    }), 1);

    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: { notificationsEnabled: true, notificationsEnabledAt: new Date() },
    });
  });

  await t.test('an exact OFF revision cancels a future ON boundary without an enrollment window', async () => {
    const exactBoundary = new Date(Date.now() + 60_000);
    const publishedAt = new Date();
    await prisma.storeOnboardingRolloutRevision.create({
      data: {
        country: Country.MX,
        kaType: KaType.CKA,
        revision: 2,
        enabled: true,
        effectiveAt: exactBoundary,
        activatedAt: publishedAt,
        workflowVersion: 'cka-v1',
        newRequestsOnly: true,
        timezone: 'America/Mexico_City',
        createdById: MANAGER_ID,
        sourceTaskTypes: { create: { source: StoreOnboardingSource.create, taskTypeId: createType.id } },
      },
    });
    await prisma.storeOnboardingRolloutRevision.create({
      data: {
        country: Country.MX,
        kaType: KaType.CKA,
        revision: 3,
        enabled: false,
        effectiveAt: exactBoundary,
        activatedAt: new Date(publishedAt.getTime() + 1),
        workflowVersion: 'cka-v1',
        newRequestsOnly: true,
        timezone: 'America/Mexico_City',
        createdById: MANAGER_ID,
        sourceTaskTypes: { create: { source: StoreOnboardingSource.create, taskTypeId: createType.id } },
      },
    });
    const brand = await createBrand(Country.MX, KaType.CKA, 'cka-future-cancelled');
    const created = await createStoreTask(brand, exactBoundary);
    assert.equal(created.registration.enrolled, false);
    assert.equal(created.registration.reason, 'scope_disabled');
    assert.equal(await prisma.storeOnboardingRequest.count({ where: { taskId: created.task.id } }), 0);
  });

  await t.test('a published scope OFF revision excludes only new Tasks and preserves enrolled history', async () => {
    const before = await prisma.storeOnboardingTaskEnrollment.count({
      where: { decision: StoreOnboardingEnrollmentDecision.enrolled },
    });
    const offBoundary = new Date(boundary.getTime() + 10_000);
    await prisma.storeOnboardingRolloutRevision.create({
      data: {
        country: Country.MX,
        kaType: KaType.SME,
        revision: 2,
        enabled: false,
        effectiveAt: offBoundary,
        activatedAt: offBoundary,
        workflowVersion: 'sme-v1',
        newRequestsOnly: true,
        timezone: 'America/Mexico_City',
        createdById: MANAGER_ID,
        sourceTaskTypes: { create: { source: StoreOnboardingSource.create, taskTypeId: createType.id } },
      },
    });
    const brand = await createBrand(Country.MX, KaType.SME, 'sme-disabled');
    const created = await createStoreTask(brand, new Date(offBoundary.getTime() + 1));
    assert.equal(created.registration.enrolled, false);
    assert.equal(created.registration.reason, 'scope_disabled');
    assert.equal(await prisma.storeOnboardingRequest.count({ where: { taskId: created.task.id } }), 0);
    assert.equal(await prisma.storeOnboardingTaskEnrollment.count({
      where: { decision: StoreOnboardingEnrollmentDecision.enrolled },
    }), before);
  });

  await t.test('scope deactivation preserves enrolled history while master OFF is a hard kill switch', async () => {
    const enrollmentCount = await prisma.storeOnboardingTaskEnrollment.count({
      where: { decision: StoreOnboardingEnrollmentDecision.enrolled },
    });
    assert.ok(enrollmentCount >= 5);
    await prisma.storeOnboardingControl.update({
      where: { id: 'default' },
      data: { globalEnabled: false, notificationsEnabled: false },
    });
    await assert.rejects(service.list({}), ConflictException);
    const callsBefore = gatewayCalls;
    await assert.rejects(service.goLive(randomUUID(), { unitIds: [randomUUID()] }, owner), ConflictException);
    assert.equal(gatewayCalls, callsBefore);
    assert.equal(await prisma.storeOnboardingTaskEnrollment.count({
      where: { decision: StoreOnboardingEnrollmentDecision.enrolled },
    }), enrollmentCount);
  });

  assert.equal(gatewayCalls, 7);
  assert.equal(await prisma.storeOnboardingNotificationDelivery.count(), 0);
});
