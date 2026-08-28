import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import {
  AccountRole,
  AutoOpenStatus,
  DidiBindingEnvironment,
  DidiStoreBindingAction,
  DidiStoreBindingItemStatus,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DidiStoreBindingCoordinator } from '../src/file-integrations/didi-store-binding-coordinator.service';
import { DidiStoreBindingExecutionProcessor } from '../src/file-integrations/didi-store-binding-execution.processor';
import { DidiStoreBindingExecutionsService } from '../src/file-integrations/didi-store-binding-executions.service';
import { CreateDidiStoreBindingExecutionDto } from '../src/file-integrations/dto/didi-store-binding.dto';
import { exactConfirmation, fingerprintBindingBatch } from '../src/file-integrations/didi-store-bindings.util';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const APP_ID = '5764607654490537999';
const shop = (index: number, remotePageNo?: number) => ({
  shopId: `57${String(index).padStart(17, '0')}`,
  appShopId: `shop-${index}`,
  ...(remotePageNo ? { remotePageNo } : {}),
});

test('mass DTO accepts 7000 exact mappings, rejects 7001, and fits the explicit 8 MB JSON budget', async () => {
  const shops = Array.from({ length: 7000 }, (_, index) => ({
    ...shop(index),
    appShopId: `S${String(index).padStart(6, '0')}-${'x'.repeat(119)}`,
  }));
  const payload = {
    idempotencyKey: IDEMPOTENCY_KEY,
    applicationId: APPLICATION_ID,
    action: 'bind',
    shops,
    confirmation: 'VINCULAR 7000 TIENDAS',
  };
  const valid = plainToInstance(CreateDidiStoreBindingExecutionDto, payload);
  assert.equal((await validate(valid)).length, 0);
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(bytes > 100 * 1024, 'payload must exercise the old Express default limit');
  assert.ok(bytes < 8 * 1024 * 1024, 'maximum supported payload must fit the configured bounded limit');

  const invalid = plainToInstance(CreateDidiStoreBindingExecutionDto, {
    ...payload,
    shops: [...shops, shop(7000)],
  });
  assert.ok((await validate(invalid)).some(error => error.property === 'shops'));

  const controlCharacter = plainToInstance(CreateDidiStoreBindingExecutionDto, {
    ...payload,
    shops: [{ shopId: shop(1).shopId, appShopId: `bad\u0001id` }],
    confirmation: 'VINCULAR 1 TIENDAS',
  });
  assert.ok((await validate(controlCharacter)).some(error => error.property === 'shops'));
});

test('production mass Unbind uses a canonical batch fingerprint while one store keeps SHOP_ID compatibility', () => {
  const shops = [shop(2, 2), shop(1, 1)];
  assert.equal(
    exactConfirmation('unbind', shops, 'production', APP_ID),
    `PRODUCCION DESVINCULAR 2 TIENDAS APP_ID ${APP_ID} LOTE ${fingerprintBindingBatch(shops)}`,
  );
  assert.equal(
    exactConfirmation('unbind', [shops[0]], 'production', APP_ID),
    `PRODUCCION DESVINCULAR 1 TIENDAS APP_ID ${APP_ID} SHOP_ID ${shops[0].shopId}`,
  );
});

test('coordinator serializes operations for one Application and permits another Application', async () => {
  const coordinator = new DidiStoreBindingCoordinator({
    get: (_key: string, fallback: string) => fallback,
  } as never);
  let release!: () => void;
  const first = coordinator.withLock(APPLICATION_ID, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    coordinator.withLock(APPLICATION_ID, async () => undefined),
    /Another DiDi bind\/unbind operation/,
  );
  await coordinator.withLock('44444444-4444-4444-8444-444444444444', async () => undefined);
  release();
  await first;
});

function publicExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: IDEMPOTENCY_KEY,
    requestFingerprint: '',
    applicationSnapshotFingerprint: 'snapshot',
    applicationAppIdSnapshot: APP_ID,
    applicationId: APPLICATION_ID,
    action: DidiStoreBindingAction.bind,
    status: AutoOpenStatus.pending,
    environment: DidiBindingEnvironment.TEST,
    totalShops: 1,
    processedShops: 0,
    successfulShops: 0,
    failedShops: 0,
    unconfirmedShops: 0,
    currentShopId: null,
    currentBatch: null,
    totalBatches: 1,
    cancelRequested: false,
    reason: null,
    batchFingerprint: 'ABC',
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdById: ACTOR_ID,
    createdAt: new Date('2026-08-28T00:00:00Z'),
    updatedAt: new Date('2026-08-28T00:00:00Z'),
    application: {
      id: APPLICATION_ID,
      appId: APP_ID,
      appName: 'Test app',
      country: 'MX',
      didiBindingEnvironment: DidiBindingEnvironment.TEST,
    },
    createdBy: { id: ACTOR_ID, name: 'Admin', email: 'admin@example.com' },
    ...overrides,
  };
}

test('idempotency key returns the original execution and conflicts on a changed payload', async () => {
  let stored = publicExecution();
  const prisma = {
    didiStoreBindingExecution: { findUnique: async () => stored },
  };
  const service = new DidiStoreBindingExecutionsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const dto = plainToInstance(CreateDidiStoreBindingExecutionDto, {
    idempotencyKey: IDEMPOTENCY_KEY,
    applicationId: APPLICATION_ID,
    action: 'bind',
    shops: [shop(1)],
    confirmation: 'VINCULAR 1 TIENDAS',
  });
  stored = publicExecution({
    requestFingerprint: (service as unknown as {
      requestFingerprint(value: CreateDidiStoreBindingExecutionDto): string;
    }).requestFingerprint(dto),
  });
  const repeated = await service.create(dto, ACTOR_ID, [AccountRole.admin]);
  assert.equal(repeated.execution.id, stored.id);

  const changed = plainToInstance(CreateDidiStoreBindingExecutionDto, {
    ...dto,
    shops: [shop(2)],
  });
  await assert.rejects(service.create(changed, ACTOR_ID, [AccountRole.admin]), ConflictException);
});

test('repeating cancellation after a timeout returns the durable cancelled execution', async () => {
  const cancelled = publicExecution({
    status: AutoOpenStatus.cancelled,
    cancelRequested: true,
    processedShops: 1,
    failedShops: 0,
    finishedAt: new Date('2026-08-28T00:01:00Z'),
  });
  let writes = 0;
  const service = new DidiStoreBindingExecutionsService(
    {
      didiStoreBindingExecution: {
        findUnique: async () => cancelled,
        updateMany: async () => { writes += 1; return { count: 0 }; },
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.cancel(cancelled.id, ACTOR_ID);
  assert.equal(result.cancelRequested, true);
  assert.equal(result.execution.status, AutoOpenStatus.cancelled);
  assert.equal(result.execution.id, cancelled.id);
  assert.equal(writes, 0);
});

test('startup replaces a terminal BullMQ job for an active DB execution with a recovery job', async () => {
  const added: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
  let removed = false;
  const queue = {
    getJob: async (id: string) => id.endsWith('-recovery') ? null : ({
      getState: async () => 'failed',
      remove: async () => { removed = true; },
    }),
    add: async (name: string, data: unknown, options: Record<string, unknown>) => {
      added.push({ name, data, options });
      return {};
    },
  };
  const service = new DidiStoreBindingExecutionsService(
    { didiStoreBindingExecution: { findMany: async () => [{ id: 'execution-1' }] } } as never,
    {} as never,
    {} as never,
    queue as never,
  );
  await service.onModuleInit();
  assert.equal(removed, true);
  assert.equal(added.length, 1);
  assert.equal(added[0].options.jobId, 'execution-1-recovery');
});

test('Bind processor chunks 51 shops into 50 + 1 and persists submitting before each POST', async () => {
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `item-${index}`,
    executionId: 'execution-1',
    ordinal: index + 1,
    ...shop(index),
    status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus,
  }));
  const batchSizes: number[] = [];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const bindings = {
    executeDurableBindBatch: async (
      _applicationId: string,
      shops: Array<{ shopId: string; appShopId: string }>,
      _environment: string,
      _snapshot: string,
      beforeSubmit: () => Promise<void>,
    ) => {
      batchSizes.push(shops.length);
      await beforeSubmit();
      assert.ok(items.filter(item => item.status === DidiStoreBindingItemStatus.submitting).length >= shops.length);
      return shops.map(value => ({ ...value, status: 'success' as const }));
    },
  };
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    bindings as never,
    { recalculate: async () => ({ status: AutoOpenStatus.running }) } as never,
  );
  await (processor as unknown as {
    processBind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processBind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.deepEqual(batchSizes, [50, 1]);
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.success).length, 51);
});

test('Bind processor handles the 7,000-store maximum as exactly 140 safe batches of 50', async () => {
  const items = Array.from({ length: 7000 }, (_, index) => ({
    id: `bulk-item-${index}`,
    executionId: 'execution-1',
    ordinal: index + 1,
    ...shop(index),
    status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus,
  }));
  const batchSizes: number[] = [];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      executeDurableBindBatch: async (
        _applicationId: string,
        shops: Array<{ shopId: string; appShopId: string }>,
        _environment: string,
        _snapshot: string,
        beforeSubmit: () => Promise<void>,
      ) => {
        batchSizes.push(shops.length);
        await beforeSubmit();
        return shops.map(value => ({ ...value, status: 'success' as const }));
      },
    } as never,
    { recalculate: async () => ({ status: AutoOpenStatus.running }) } as never,
  );
  await (processor as unknown as {
    processBind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processBind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.equal(batchSizes.length, 140);
  assert.ok(batchSizes.every(size => size === 50));
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.success).length, 7000);
});

test('Bind circuit breaker stops all safe pending work after one unconfirmed batch', async () => {
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `item-${index}`,
    executionId: 'execution-1',
    ordinal: index + 1,
    ...shop(index),
    status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus,
  }));
  let providerCalls = 0;
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      executeDurableBindBatch: async (
        _app: string,
        shops: Array<{ shopId: string; appShopId: string }>,
        _env: string,
        _snapshot: string,
        beforeSubmit: () => Promise<void>,
      ) => {
        providerCalls += 1;
        await beforeSubmit();
        return shops.map(value => ({ ...value, status: 'unconfirmed' as const, reason: 'ambiguous response' }));
      },
    } as never,
    { recalculate: async () => ({ status: AutoOpenStatus.running }) } as never,
  );
  await (processor as unknown as {
    processBind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processBind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.equal(providerCalls, 1);
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.unconfirmed).length, 50);
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.failed).length, 1);
});

test('Unbind processor verifies every remote page freshly in complete descending order', async () => {
  const items = [
    { id: 'low', executionId: 'execution-1', ordinal: 1, ...shop(1, 1), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
    { id: 'high', executionId: 'execution-1', ordinal: 2, ...shop(2, 7), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
    { id: 'middle', executionId: 'execution-1', ordinal: 3, ...shop(3, 3), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
  ];
  const verifiedPages: number[] = [];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const bindings = {
    verifyDurableUnbindPage: async (
      _applicationId: string,
      shops: Array<{ shopId: string; appShopId: string }>,
      pageNo: number,
    ) => {
      verifiedPages.push(pageNo);
      return { shops, failures: [] };
    },
    executeDurableUnbindItem: async (
      _applicationId: string,
      value: { shopId: string; appShopId: string },
      _environment: string,
      _snapshot: string,
      beforeSubmit: () => Promise<void>,
    ) => {
      await beforeSubmit();
      return { ...value, status: 'success' as const };
    },
  };
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    bindings as never,
    {
      recalculate: async () => ({ status: AutoOpenStatus.running }),
      cancelRemaining: async () => ({ status: AutoOpenStatus.cancelled }),
    } as never,
  );
  await (processor as unknown as {
    processUnbind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processUnbind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.deepEqual(verifiedPages, [7, 3, 1]);
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.success).length, 3);
});

test('Unbind circuit breaker never advances after one ambiguous submitted item', async () => {
  const items = [
    { id: 'high', executionId: 'execution-1', ordinal: 1, ...shop(1, 7), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
    { id: 'low', executionId: 'execution-1', ordinal: 2, ...shop(2, 1), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
  ];
  let providerCalls = 0;
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      verifyDurableUnbindPage: async (
        _app: string,
        shops: Array<{ shopId: string; appShopId: string }>,
      ) => ({ shops, failures: [] }),
      executeDurableUnbindItem: async (
        _app: string,
        value: { shopId: string; appShopId: string },
        _env: string,
        _snapshot: string,
        beforeSubmit: () => Promise<void>,
      ) => {
        providerCalls += 1;
        await beforeSubmit();
        return { ...value, status: 'unconfirmed' as const, reason: 'timeout', submissionStarted: true };
      },
    } as never,
    { recalculate: async () => ({ status: AutoOpenStatus.running }) } as never,
  );
  await (processor as unknown as {
    processUnbind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processUnbind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.equal(providerCalls, 1);
  assert.equal(items.find(item => item.id === 'high')?.status, DidiStoreBindingItemStatus.unconfirmed);
  assert.equal(items.find(item => item.id === 'low')?.status, DidiStoreBindingItemStatus.failed);
});

test('Unbind mapping failures do not trip the systemic pre-submit circuit for valid peers', async () => {
  const items = Array.from({ length: 11 }, (_, index) => ({
    id: `page-item-${index}`,
    executionId: 'execution-1',
    ordinal: index + 1,
    ...shop(index, 2),
    status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus,
  }));
  let providerCalls = 0;
  const prisma = inMemoryProcessorPrisma(items, () => false);
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      verifyDurableUnbindPage: async () => ({
        failures: items.slice(0, 10).map(item => ({
          shopId: item.shopId,
          appShopId: item.appShopId,
          reason: 'mapping mismatch',
        })),
        shops: [items[10]],
      }),
      executeDurableUnbindItem: async (
        _app: string,
        value: { shopId: string; appShopId: string },
        _env: string,
        _snapshot: string,
        beforeSubmit: () => Promise<void>,
      ) => {
        providerCalls += 1;
        await beforeSubmit();
        return { ...value, status: 'success' as const };
      },
    } as never,
    { recalculate: async () => ({ status: AutoOpenStatus.running }) } as never,
  );
  await (processor as unknown as {
    processUnbind(id: string, app: string, env: 'test', snapshot: string): Promise<void>;
  }).processUnbind('execution-1', APPLICATION_ID, 'test', 'snapshot');
  assert.equal(providerCalls, 1);
  assert.equal(items.filter(item => item.status === DidiStoreBindingItemStatus.failed).length, 10);
  assert.equal(items[10].status, DidiStoreBindingItemStatus.success);
});

test('a recovered submitting item becomes unconfirmed and is never posted again', async () => {
  const item = {
    id: 'item-1', executionId: 'execution-1', ordinal: 1, ...shop(1),
    status: DidiStoreBindingItemStatus.submitting as DidiStoreBindingItemStatus,
  };
  let providerCalls = 0;
  const prisma = inMemoryProcessorPrisma([item], () => false, {
    id: 'execution-1', applicationId: APPLICATION_ID, status: AutoOpenStatus.running,
    environment: DidiBindingEnvironment.TEST, action: DidiStoreBindingAction.bind,
    applicationSnapshotFingerprint: 'snapshot', startedAt: new Date(), cancelRequested: false,
  });
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      assertDurableRuntimeAllowed: async () => ({}),
      withDurableOperationLock: async (_id: string, operation: () => Promise<void>) => operation(),
      executeDurableBindBatch: async () => { providerCalls += 1; return []; },
    } as never,
    { recalculate: async () => ({ status: AutoOpenStatus.failed, cancelRequested: false }) } as never,
  );
  await processor.process({ data: { executionId: 'execution-1' } } as never);
  assert.equal(item.status, DidiStoreBindingItemStatus.unconfirmed);
  assert.equal(providerCalls, 0);
});

test('restart guard stops pending work when an earlier item was already unconfirmed', async () => {
  const items = [
    { id: 'uncertain', executionId: 'execution-1', ordinal: 1, ...shop(1), status: DidiStoreBindingItemStatus.unconfirmed as DidiStoreBindingItemStatus },
    { id: 'pending', executionId: 'execution-1', ordinal: 2, ...shop(2), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
  ];
  let providerCalls = 0;
  const prisma = inMemoryProcessorPrisma(items, () => false, {
    id: 'execution-1', applicationId: APPLICATION_ID, status: AutoOpenStatus.running,
    environment: DidiBindingEnvironment.TEST, action: DidiStoreBindingAction.bind,
    applicationSnapshotFingerprint: 'snapshot', startedAt: new Date(), cancelRequested: false,
  });
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {
      withDurableOperationLock: async (_id: string, operation: () => Promise<void>) => operation(),
      executeDurableBindBatch: async () => { providerCalls += 1; return []; },
    } as never,
    {
      recalculate: async () => ({
        status: items.some(item => item.status === DidiStoreBindingItemStatus.pending)
          ? AutoOpenStatus.running
          : AutoOpenStatus.failed,
        cancelRequested: false,
        unconfirmedShops: 1,
      }),
    } as never,
  );
  await processor.process({ data: { executionId: 'execution-1' } } as never);
  assert.equal(providerCalls, 0);
  assert.equal(items.find(item => item.id === 'pending')?.status, DidiStoreBindingItemStatus.failed);
});

test('final worker failure terminalizes pending/processing and marks submitting unconfirmed', async () => {
  const items = [
    { id: 'pending', executionId: 'execution-1', ordinal: 1, ...shop(1), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
    { id: 'processing', executionId: 'execution-1', ordinal: 2, ...shop(2), status: DidiStoreBindingItemStatus.processing as DidiStoreBindingItemStatus },
    { id: 'submitting', executionId: 'execution-1', ordinal: 3, ...shop(3), status: DidiStoreBindingItemStatus.submitting as DidiStoreBindingItemStatus },
  ];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  let finalStatus: AutoOpenStatus = AutoOpenStatus.running;
  const activeItemStatuses: DidiStoreBindingItemStatus[] = [
    DidiStoreBindingItemStatus.pending,
    DidiStoreBindingItemStatus.processing,
    DidiStoreBindingItemStatus.submitting,
  ];
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {} as never,
    {
      recalculate: async () => {
        const active = items.some(item => activeItemStatuses.includes(item.status));
        finalStatus = active ? AutoOpenStatus.running : AutoOpenStatus.failed;
        return { status: finalStatus };
      },
    } as never,
  );
  await processor.onFailed({
    data: { executionId: 'execution-1' },
    opts: { attempts: 3 },
    attemptsMade: 3,
  } as never, new Error('terminal worker error'));
  assert.equal(items.find(item => item.id === 'pending')?.status, DidiStoreBindingItemStatus.failed);
  assert.equal(items.find(item => item.id === 'processing')?.status, DidiStoreBindingItemStatus.failed);
  assert.equal(items.find(item => item.id === 'submitting')?.status, DidiStoreBindingItemStatus.unconfirmed);
  assert.equal(finalStatus, AutoOpenStatus.failed);
});

test('an unrecoverable stalled Bull job terminalizes DB work even with retry attempts remaining', async () => {
  const items = [
    { id: 'pending', executionId: 'execution-1', ordinal: 1, ...shop(1), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
    { id: 'submitting', executionId: 'execution-1', ordinal: 2, ...shop(2), status: DidiStoreBindingItemStatus.submitting as DidiStoreBindingItemStatus },
  ];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  let recalculations = 0;
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {} as never,
    { recalculate: async () => { recalculations += 1; return { status: AutoOpenStatus.failed }; } } as never,
  );
  const error = new Error('job stalled more than allowable limit');
  error.name = 'UnrecoverableError';
  await processor.onFailed({
    data: { executionId: 'execution-1' },
    opts: { attempts: 3 },
    attemptsMade: 1,
    getState: async () => 'failed',
  } as never, error);
  assert.equal(items[0].status, DidiStoreBindingItemStatus.failed);
  assert.equal(items[1].status, DidiStoreBindingItemStatus.unconfirmed);
  assert.equal(recalculations, 1);
});

test('a retryable Bull failure leaves DB items active while the job is delayed', async () => {
  const items = [
    { id: 'pending', executionId: 'execution-1', ordinal: 1, ...shop(1), status: DidiStoreBindingItemStatus.pending as DidiStoreBindingItemStatus },
  ];
  const prisma = inMemoryProcessorPrisma(items, () => false);
  let recalculations = 0;
  const processor = new DidiStoreBindingExecutionProcessor(
    prisma as never,
    {} as never,
    { recalculate: async () => { recalculations += 1; return { status: AutoOpenStatus.running }; } } as never,
  );
  await processor.onFailed({
    data: { executionId: 'execution-1' },
    opts: { attempts: 3 },
    attemptsMade: 1,
    getState: async () => 'delayed',
  } as never, new Error('retryable worker error'));
  assert.equal(items[0].status, DidiStoreBindingItemStatus.pending);
  assert.equal(recalculations, 0);
});

function inMemoryProcessorPrisma(
  items: Array<Record<string, unknown> & { id: string; status: DidiStoreBindingItemStatus }>,
  cancelRequested: () => boolean,
  executionOverride: Record<string, unknown> = {},
) {
  const execution = {
    id: 'execution-1', applicationId: APPLICATION_ID, status: AutoOpenStatus.running,
    environment: DidiBindingEnvironment.TEST, action: DidiStoreBindingAction.bind,
    applicationSnapshotFingerprint: 'snapshot', startedAt: new Date(), cancelRequested: false,
    ...executionOverride,
  };
  const matches = (item: typeof items[number], where: Record<string, unknown>) => {
    const id = where.id as string | { in?: string[] } | undefined;
    if (typeof id === 'string' && item.id !== id) return false;
    if (id && typeof id === 'object' && id.in && !id.in.includes(item.id)) return false;
    if (where.executionId && item.executionId !== where.executionId) return false;
    if (where.remotePageNo !== undefined && item.remotePageNo !== where.remotePageNo) return false;
    const status = where.status as DidiStoreBindingItemStatus | { in?: DidiStoreBindingItemStatus[] } | undefined;
    if (typeof status === 'string' && item.status !== status) return false;
    if (status && typeof status === 'object' && status.in && !status.in.includes(item.status)) return false;
    return true;
  };
  const itemDelegate = {
    findMany: async ({ where, take, select, orderBy }: {
      where: Record<string, unknown>; take?: number; select?: unknown; orderBy?: Record<string, string>;
    }) => {
      let rows = items.filter(item => matches(item, where));
      if (select && 'remotePageNo' in (select as object)) {
        const pages = [...new Set(rows.map(item => item.remotePageNo))];
        return pages.map(remotePageNo => ({ remotePageNo }));
      }
      rows = [...rows].sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      if (orderBy?.remotePageNo === 'desc') rows.sort((a, b) => Number(b.remotePageNo) - Number(a.remotePageNo));
      return take ? rows.slice(0, take) : rows;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = items.filter(item => matches(item, where));
      rows.forEach(item => Object.assign(item, data));
      return { count: rows.length };
    },
    count: async ({ where }: { where: Record<string, unknown> }) => items.filter(item => matches(item, where)).length,
  };
  return {
    didiStoreBindingExecutionItem: itemDelegate,
    didiStoreBindingExecution: {
      findUnique: async ({ select }: { select?: unknown }) => select
        ? { cancelRequested: cancelRequested() }
        : { ...execution, cancelRequested: cancelRequested() },
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(execution, data),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
}
