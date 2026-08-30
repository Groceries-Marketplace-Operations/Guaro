import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import {
  catalogMutationResourceKey,
  OperationalLeaseHandle,
  OperationalLeaseLostError,
  OperationalLeaseService,
  OperationalLeaseUnavailableError,
  upcExecutionResourceKey,
} from '../src/prisma/operational-lease.service';

const now = new Date('2026-08-30T12:00:00.000Z');

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    resourceKey: 'catalog-write:app-1:shop-1',
    ownerToken: '00000000-0000-4000-8000-000000000001',
    ownerKind: 'upc-activity-price',
    ownerId: 'execution-1',
    fencingToken: '41',
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    ...overrides,
  };
}

function handle(overrides: Partial<OperationalLeaseHandle> = {}): OperationalLeaseHandle {
  return {
    resourceKey: 'catalog-write:app-1:shop-1',
    ownerToken: '00000000-0000-4000-8000-000000000001',
    ownerKind: 'upc-activity-price',
    ownerId: 'execution-1',
    fencingToken: 41n,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    ttlMs: 60_000,
    ...overrides,
  };
}

function sqlText(statement: unknown) {
  const value = statement as { sql?: string; text?: string };
  return value.sql ?? value.text ?? String(statement);
}

class QueryPrisma {
  readonly calls: unknown[] = [];
  readonly transactionCalls: unknown[] = [];
  constructor(
    private readonly results: unknown[][] = [],
    private readonly transactionResults: unknown[][] = [],
  ) {}

  $queryRaw = async (statement: unknown) => {
    this.calls.push(statement);
    return this.results.shift() ?? [];
  };

  $transaction = async <T>(callback: (transaction: unknown) => Promise<T>) => {
    const transaction = {
      $queryRaw: async (statement: unknown) => {
        this.transactionCalls.push(statement);
        return this.transactionResults.shift() ?? [];
      },
    };
    return callback(transaction);
  };
}

test('resource key helpers are canonical and reject missing identifiers', () => {
  assert.equal(
    catalogMutationResourceKey(' app-1 ', ' shop-1 '),
    'catalog-write:app-1:shop-1',
  );
  assert.equal(
    upcExecutionResourceKey(' execution-1 '),
    'upc-activity-price-execution:execution-1',
  );
  assert.throws(() => catalogMutationResourceKey('', 'shop-1'), TypeError);
  assert.throws(() => upcExecutionResourceKey('  '), TypeError);
});

test('acquire uses an atomic DB-clock upsert and returns the persisted fence', async () => {
  const prisma = new QueryPrisma([[leaseRow()]]);
  const service = new OperationalLeaseService(prisma as never);

  const acquired = await service.acquire(
    'catalog-write:app-1:shop-1',
    'upc-activity-price',
    'execution-1',
    { ttlMs: 90_000 },
  );

  assert.ok(acquired);
  assert.equal(acquired.fencingToken, 41n);
  assert.equal(acquired.ttlMs, 90_000);
  assert.equal(acquired.expiresAt.toISOString(), '2026-08-30T12:01:00.000Z');
  const query = sqlText(prisma.calls[0]);
  assert.match(query, /ON CONFLICT \("resource_key"\) DO UPDATE/i);
  assert.match(query, /"fencing_token" \+ 1/i);
  assert.match(query, /CURRENT_TIMESTAMP/i);
  assert.match(query, /"expires_at" <= CURRENT_TIMESTAMP/i);
  const values = (prisma.calls[0] as { values?: unknown[] }).values ?? [];
  assert.ok(values.some(value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)));
});

test('acquire returns null without stealing an unexpired lease', async () => {
  const prisma = new QueryPrisma([[]]);
  const service = new OperationalLeaseService(prisma as never);

  const acquired = await service.acquire('resource-1', 'worker', 'run-1');

  assert.equal(acquired, null);
});

test('live UPC allowlist reserves the pilot store from every non-UPC catalog writer', async () => {
  const prisma = new QueryPrisma([[leaseRow()]]);
  const config = {
    get: (key: string, fallback: string) => ({
      UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED: 'true',
      UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST: 'shop-1',
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new OperationalLeaseService(prisma as never, config as never);

  await assert.rejects(
    () => service.acquire('catalog-write:app-1:shop-1', 'menu-copy', 'execution-2'),
    OperationalLeaseUnavailableError,
  );
  assert.equal(prisma.calls.length, 0, 'a reserved store must be rejected before the lease query');

  const acquired = await service.acquire(
    'catalog-write:app-1:shop-1',
    'upc-activity-price',
    'execution-1',
  );
  assert.ok(acquired, 'the UPC owner must still be able to acquire its reserved store');
});

test('the pilot reservation remains dormant while the UPC live gate is off', async () => {
  const prisma = new QueryPrisma([[leaseRow({ ownerKind: 'menu-copy', ownerId: 'execution-2' })]]);
  const config = {
    get: (key: string, fallback: string) => ({
      UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED: 'false',
      UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST: 'shop-1',
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new OperationalLeaseService(prisma as never, config as never);

  const acquired = await service.acquire(
    'catalog-write:app-1:shop-1',
    'menu-copy',
    'execution-2',
  );
  assert.ok(acquired);
});

test('renew and assertOwned fail closed for stale or expired fences', async () => {
  const prisma = new QueryPrisma([
    [leaseRow({ heartbeatAt: new Date(now.getTime() + 1_000) })],
    [],
    [],
  ]);
  const service = new OperationalLeaseService(prisma as never);
  const owned = handle();

  const renewed = await service.renew(owned);
  assert.equal(renewed.fencingToken, owned.fencingToken);
  assert.equal(renewed.heartbeatAt.toISOString(), '2026-08-30T12:00:01.000Z');
  await assert.rejects(() => service.renew(owned), OperationalLeaseLostError);
  await assert.rejects(() => service.assertOwned(owned), error => {
    assert.ok(error instanceof OperationalLeaseLostError);
    assert.equal(error.resourceKey, owned.resourceKey);
    assert.equal(error.ownerToken, owned.ownerToken);
    assert.equal(error.fencingToken, owned.fencingToken);
    return true;
  });
});

test('release is fenced, retains the row, and cannot release a newer owner', async () => {
  const prisma = new QueryPrisma([
    [{ resourceKey: handle().resourceKey }],
    [],
  ]);
  const service = new OperationalLeaseService(prisma as never);

  assert.equal(await service.release(handle()), true);
  assert.equal(await service.release(handle({ fencingToken: 40n })), false);
  const query = sqlText(prisma.calls[0]);
  assert.match(query, /^\s*UPDATE "operational_lease"/i);
  assert.doesNotMatch(query, /DELETE/i);
  assert.match(query, /"owner_token" = NULL/i);
  assert.match(query, /"fencing_token" =/i);
});

test('withFencedTransaction locks the lease row before invoking the callback', async () => {
  const prisma = new QueryPrisma([], [[leaseRow()]]);
  const service = new OperationalLeaseService(prisma as never);
  let callbackTransaction: unknown;

  const value = await service.withFencedTransaction(handle(), async transaction => {
    callbackTransaction = transaction;
    return 'checkpoint-written';
  });

  assert.equal(value, 'checkpoint-written');
  assert.ok(callbackTransaction);
  assert.match(sqlText(prisma.transactionCalls[0]), /FOR UPDATE/i);
  assert.match(sqlText(prisma.transactionCalls[0]), /"expires_at" > CURRENT_TIMESTAMP/i);
});

test('withFencedTransaction never calls the callback after ownership loss', async () => {
  const prisma = new QueryPrisma([], [[]]);
  const service = new OperationalLeaseService(prisma as never);
  let called = false;

  await assert.rejects(
    () => service.withFencedTransaction(handle(), async () => {
      called = true;
    }),
    OperationalLeaseLostError,
  );
  assert.equal(called, false);
});

class ScriptedLeaseService extends OperationalLeaseService {
  acquireAttempts = 0;
  renewals = 0;
  assertions = 0;
  releases = 0;
  busyAttempts = 0;
  loseOnRenew = false;

  constructor() {
    super({} as never);
  }

  override async acquire(
    _resourceKey: string,
    _ownerKind: string,
    _ownerId: string,
    options: { ttlMs?: number } = {},
  ) {
    this.acquireAttempts += 1;
    if (this.acquireAttempts <= this.busyAttempts) return null;
    return handle({ ttlMs: options.ttlMs ?? 60_000 });
  }

  override async renew(current: OperationalLeaseHandle) {
    this.renewals += 1;
    if (this.loseOnRenew) {
      throw new OperationalLeaseLostError(current.resourceKey, 'simulated loss', current);
    }
    return handle({
      ...current,
      heartbeatAt: new Date(current.heartbeatAt.getTime() + 1_000),
      expiresAt: new Date(current.expiresAt.getTime() + current.ttlMs),
    });
  }

  override async assertOwned(current: OperationalLeaseHandle) {
    this.assertions += 1;
    return current;
  }

  override async release(_current: OperationalLeaseHandle) {
    this.releases += 1;
    return true;
  }

  override async withFencedTransaction<T>(
    _current: OperationalLeaseHandle,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ) {
    return callback({ marker: 'transaction' } as never);
  }
}

test('runExclusive can wait, exposes fencing helpers, and always releases', async () => {
  const service = new ScriptedLeaseService();
  service.busyAttempts = 1;
  let callerGuardChecks = 0;

  const result = await service.runExclusive(
    {
      resourceKey: handle().resourceKey,
      ownerKind: 'upc-activity-price',
      ownerId: 'execution-1',
      ttlMs: 100,
      heartbeatIntervalMs: 30,
      wait: true,
      waitTimeoutMs: 200,
      retryDelayMs: 1,
      ensureActive: () => {
        callerGuardChecks += 1;
        return true;
      },
    },
    async context => {
      const active = await context.ensureActive();
      assert.equal(active.fencingToken, 41n);
      const transaction = await context.withFencedTransaction(async tx =>
        (tx as unknown as { marker: string }).marker,
      );
      assert.equal(transaction, 'transaction');
      assert.equal(context.signal.aborted, false);
      return 'done';
    },
  );

  assert.equal(result, 'done');
  assert.equal(service.acquireAttempts, 2);
  assert.ok(service.assertions >= 3);
  assert.ok(callerGuardChecks >= 3);
  assert.equal(service.releases, 1);
});

test('runExclusive fails fast when the resource is busy', async () => {
  const service = new ScriptedLeaseService();
  service.busyAttempts = 1;

  await assert.rejects(
    () => service.runExclusive({
      resourceKey: handle().resourceKey,
      ownerKind: 'worker',
      ownerId: 'run-1',
      ttlMs: 100,
      heartbeatIntervalMs: 20,
    }, async () => undefined),
    OperationalLeaseUnavailableError,
  );
  assert.equal(service.releases, 0);
});

test('runExclusive heartbeat aborts the context and reports lease loss', async () => {
  const service = new ScriptedLeaseService();
  service.loseOnRenew = true;
  let observedAbort = false;

  await assert.rejects(
    () => service.runExclusive({
      resourceKey: handle().resourceKey,
      ownerKind: 'worker',
      ownerId: 'run-1',
      ttlMs: 50,
      heartbeatIntervalMs: 5,
    }, async context => {
      await new Promise(resolve => setTimeout(resolve, 20));
      observedAbort = context.signal.aborted;
      await context.ensureActive();
    }),
    OperationalLeaseLostError,
  );
  assert.equal(observedAbort, true);
  assert.ok(service.renewals >= 1);
  assert.equal(service.releases, 1);
});

test('runExclusive preserves a domain cancellation raised by the caller guard', async () => {
  const service = new ScriptedLeaseService();
  const cancellation = new Error('execution was cancelled');
  let checks = 0;

  await assert.rejects(
    () => service.runExclusive({
      resourceKey: handle().resourceKey,
      ownerKind: 'worker',
      ownerId: 'run-1',
      ttlMs: 50,
      heartbeatIntervalMs: 5,
      ensureActive: () => {
        checks += 1;
        if (checks >= 3) throw cancellation;
        return true;
      },
    }, async context => {
      await new Promise(resolve => setTimeout(resolve, 20));
      await context.ensureActive();
    }),
    error => error === cancellation,
  );
  assert.ok(checks >= 3);
  assert.equal(service.releases, 1);
});

test('runExclusive checks the caller guard before acquiring', async () => {
  const service = new ScriptedLeaseService();

  await assert.rejects(
    () => service.runExclusive({
      resourceKey: handle().resourceKey,
      ownerKind: 'worker',
      ownerId: 'run-1',
      ttlMs: 100,
      heartbeatIntervalMs: 20,
      ensureActive: () => false,
    }, async () => undefined),
    OperationalLeaseLostError,
  );
  assert.equal(service.acquireAttempts, 0);
});

test('runExclusive releases even when the action throws', async () => {
  const service = new ScriptedLeaseService();

  await assert.rejects(
    () => service.runExclusive({
      resourceKey: handle().resourceKey,
      ownerKind: 'worker',
      ownerId: 'run-1',
      ttlMs: 100,
      heartbeatIntervalMs: 20,
    }, async () => {
      throw new Error('action failed');
    }),
    /action failed/,
  );
  assert.equal(service.releases, 1);
});
