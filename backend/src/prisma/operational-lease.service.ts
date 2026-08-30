import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;

function resourceKeyPart(value: string, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  return normalized;
}

export function catalogMutationResourceKey(
  applicationId: string,
  appShopId: string,
) {
  return `catalog-write:${resourceKeyPart(applicationId, 'applicationId')}:${resourceKeyPart(appShopId, 'appShopId')}`;
}

export function upcExecutionResourceKey(executionId: string) {
  return `upc-activity-price-execution:${resourceKeyPart(executionId, 'executionId')}`;
}

export interface OperationalLeaseHandle {
  readonly resourceKey: string;
  readonly ownerToken: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly fencingToken: bigint;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
  readonly ttlMs: number;
}

export interface OperationalLeaseAcquireOptions {
  ttlMs?: number;
}

export interface OperationalLeaseExclusiveInput
  extends OperationalLeaseAcquireOptions {
  resourceKey: string;
  ownerKind: string;
  ownerId: string;
  /** Wait for the current owner to release/expire instead of failing fast. */
  wait?: boolean;
  waitTimeoutMs?: number;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Optional caller-owned guard (for example, execution cancellation/state).
   * Returning false or throwing aborts acquisition and future heartbeats.
   */
  ensureActive?: () => boolean | void | Promise<boolean | void>;
  signal?: AbortSignal;
}

export interface OperationalLeaseExclusiveContext {
  /** Returns the most recently renewed handle. */
  readonly handle: OperationalLeaseHandle;
  /** Aborts when a heartbeat, ownership assertion, or caller guard fails. */
  readonly signal: AbortSignal;
  /**
   * Must be called immediately before every irreversible/external side effect.
   * It verifies both the caller guard and the fenced lease against the DB clock.
   */
  ensureActive(): Promise<OperationalLeaseHandle>;
  /** Run a short DB-only transaction after locking and fencing the lease row. */
  withFencedTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

type LeaseRow = {
  resourceKey: string;
  ownerToken: string;
  ownerKind: string;
  ownerId: string;
  fencingToken: bigint | number | string;
  acquiredAt: Date | string;
  heartbeatAt: Date | string;
  expiresAt: Date | string;
};

type LeaseQueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export class OperationalLeaseLostError extends Error {
  readonly code = 'OPERATIONAL_LEASE_LOST';
  readonly resourceKey: string;
  readonly ownerToken?: string;
  readonly fencingToken?: bigint;

  constructor(
    resourceKey: string,
    message = 'Operational lease is no longer owned',
    handle?: Pick<OperationalLeaseHandle, 'ownerToken' | 'fencingToken'>,
    cause?: unknown,
  ) {
    super(`${message}: ${resourceKey}`);
    this.name = 'OperationalLeaseLostError';
    this.resourceKey = resourceKey;
    this.ownerToken = handle?.ownerToken;
    this.fencingToken = handle?.fencingToken;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class OperationalLeaseUnavailableError extends Error {
  readonly code = 'OPERATIONAL_LEASE_UNAVAILABLE';
  readonly resourceKey: string;

  constructor(resourceKey: string, waitedMs = 0) {
    super(
      waitedMs > 0
        ? `Operational lease remained unavailable after ${waitedMs}ms: ${resourceKey}`
        : `Operational lease is currently owned: ${resourceKey}`,
    );
    this.name = 'OperationalLeaseUnavailableError';
    this.resourceKey = resourceKey;
  }
}

/**
 * DB-backed, process-independent leases for coordinating operational work.
 *
 * Rows are retained after release so each resource's fencing token remains
 * monotonically increasing across owners. All expiry decisions use the
 * PostgreSQL clock. Callers must never perform remote I/O inside
 * `withFencedTransaction`; use it only to fence short checkpoint writes.
 */
@Injectable()
export class OperationalLeaseService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async acquire(
    resourceKey: string,
    ownerKind: string,
    ownerId: string,
    options: OperationalLeaseAcquireOptions = {},
  ): Promise<OperationalLeaseHandle | null> {
    const normalizedResourceKey = this.requireValue(resourceKey, 'resourceKey');
    const normalizedOwnerKind = this.requireValue(ownerKind, 'ownerKind');
    const normalizedOwnerId = this.requireValue(ownerId, 'ownerId');
    this.assertCatalogReservation(normalizedResourceKey, normalizedOwnerKind);
    const ttlMs = this.positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    const ownerToken = randomUUID();

    const rows = await this.prisma.$queryRaw<LeaseRow[]>(Prisma.sql`
      INSERT INTO "operational_lease" (
        "resource_key",
        "owner_token",
        "owner_kind",
        "owner_id",
        "fencing_token",
        "acquired_at",
        "heartbeat_at",
        "expires_at",
        "created_at",
        "updated_at"
      ) VALUES (
        ${normalizedResourceKey},
        ${ownerToken}::uuid,
        ${normalizedOwnerKind},
        ${normalizedOwnerId},
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond'),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("resource_key") DO UPDATE SET
        "owner_token" = EXCLUDED."owner_token",
        "owner_kind" = EXCLUDED."owner_kind",
        "owner_id" = EXCLUDED."owner_id",
        "fencing_token" = "operational_lease"."fencing_token" + 1,
        "acquired_at" = CURRENT_TIMESTAMP,
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "expires_at" = CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond'),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "operational_lease"."owner_token" IS NULL
        OR "operational_lease"."expires_at" IS NULL
        OR "operational_lease"."expires_at" <= CURRENT_TIMESTAMP
      RETURNING
        "resource_key" AS "resourceKey",
        "owner_token"::text AS "ownerToken",
        "owner_kind" AS "ownerKind",
        "owner_id" AS "ownerId",
        "fencing_token" AS "fencingToken",
        "acquired_at" AS "acquiredAt",
        "heartbeat_at" AS "heartbeatAt",
        "expires_at" AS "expiresAt"
    `);

    return rows[0] ? this.toHandle(rows[0], ttlMs) : null;
  }

  async renew(handle: OperationalLeaseHandle): Promise<OperationalLeaseHandle> {
    const ttlMs = this.positiveInteger(handle.ttlMs, 'handle.ttlMs');
    const rows = await this.prisma.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE "operational_lease"
      SET
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "expires_at" = CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond'),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "resource_key" = ${handle.resourceKey}
        AND "owner_token" = ${handle.ownerToken}::uuid
        AND "fencing_token" = ${handle.fencingToken}
        AND "expires_at" > CURRENT_TIMESTAMP
      RETURNING
        "resource_key" AS "resourceKey",
        "owner_token"::text AS "ownerToken",
        "owner_kind" AS "ownerKind",
        "owner_id" AS "ownerId",
        "fencing_token" AS "fencingToken",
        "acquired_at" AS "acquiredAt",
        "heartbeat_at" AS "heartbeatAt",
        "expires_at" AS "expiresAt"
    `);

    if (!rows[0]) {
      throw this.lost(handle, 'Operational lease could not be renewed');
    }
    return this.toHandle(rows[0], ttlMs);
  }

  async assertOwned(
    handle: OperationalLeaseHandle,
  ): Promise<OperationalLeaseHandle> {
    const row = await this.assertOwnedWithClient(this.prisma, handle, false);
    return this.toHandle(row, handle.ttlMs);
  }

  async release(handle: OperationalLeaseHandle): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ resourceKey: string }>>(
      Prisma.sql`
        UPDATE "operational_lease"
        SET
          "owner_token" = NULL,
          "owner_kind" = NULL,
          "owner_id" = NULL,
          "heartbeat_at" = CURRENT_TIMESTAMP,
          "expires_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE
          "resource_key" = ${handle.resourceKey}
          AND "owner_token" = ${handle.ownerToken}::uuid
          AND "fencing_token" = ${handle.fencingToken}
        RETURNING "resource_key" AS "resourceKey"
      `,
    );
    return rows.length === 1;
  }

  async withFencedTransaction<T>(
    handle: OperationalLeaseHandle,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async transaction => {
      await this.assertOwnedWithClient(transaction, handle, true);
      return callback(transaction);
    });
  }

  async runExclusive<T>(
    input: OperationalLeaseExclusiveInput,
    action: (context: OperationalLeaseExclusiveContext) => Promise<T>,
  ): Promise<T> {
    const resourceKey = this.requireValue(input.resourceKey, 'resourceKey');
    const ttlMs = this.positiveInteger(input.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    const waitTimeoutMs = this.nonNegativeInteger(
      input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      'waitTimeoutMs',
    );
    const retryDelayMs = this.positiveInteger(
      input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      'retryDelayMs',
    );
    const heartbeatIntervalMs = this.positiveInteger(
      input.heartbeatIntervalMs ?? Math.max(1, Math.floor(ttlMs / 3)),
      'heartbeatIntervalMs',
    );
    if (heartbeatIntervalMs >= ttlMs) {
      throw new RangeError('heartbeatIntervalMs must be less than ttlMs');
    }

    const startedAt = Date.now();
    let handle: OperationalLeaseHandle | null = null;
    while (!handle) {
      await this.assertCallerActive(resourceKey, input);
      handle = await this.acquire(resourceKey, input.ownerKind, input.ownerId, {
        ttlMs,
      });
      if (handle) break;
      if (!input.wait) {
        throw new OperationalLeaseUnavailableError(resourceKey);
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= waitTimeoutMs) {
        throw new OperationalLeaseUnavailableError(resourceKey, elapsed);
      }
      await this.delay(
        Math.min(retryDelayMs, Math.max(1, waitTimeoutMs - elapsed)),
        input.signal,
        resourceKey,
      );
    }

    let currentHandle = handle;
    let stopped = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    let leaseLoss: OperationalLeaseLostError | undefined;
    let callerFailure: unknown;
    let callerFailed = false;
    const controller = new AbortController();

    const markLost = (error: unknown) => {
      if (leaseLoss || callerFailed) return;
      leaseLoss =
        error instanceof OperationalLeaseLostError
          ? error
          : this.lost(currentHandle, 'Operational lease heartbeat failed', error);
      controller.abort(leaseLoss);
    };

    const markCallerFailed = (error: unknown) => {
      if (leaseLoss || callerFailed) return;
      callerFailed = true;
      callerFailure = error;
      controller.abort(error);
    };

    const externalAbort = () => {
      markLost(
        this.lost(
          currentHandle,
          'Operational lease caller signal was aborted',
          input.signal?.reason,
        ),
      );
    };
    input.signal?.addEventListener('abort', externalAbort, { once: true });
    if (input.signal?.aborted) externalAbort();

    const heartbeat = async () => {
      try {
        await this.assertCallerActive(resourceKey, input);
      } catch (error) {
        markCallerFailed(error);
        return;
      }
      try {
        currentHandle = await this.renew(currentHandle);
      } catch (error) {
        markLost(error);
      }
    };

    const scheduleHeartbeat = () => {
      if (stopped || leaseLoss || callerFailed) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatInFlight = heartbeat().finally(() => {
          heartbeatInFlight = undefined;
          scheduleHeartbeat();
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };

    const stopHeartbeat = async () => {
      if (stopped) {
        if (heartbeatInFlight) await heartbeatInFlight;
        return;
      }
      stopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
    };

    const ensureActive = async () => {
      if (leaseLoss) throw leaseLoss;
      if (callerFailed) throw callerFailure;
      try {
        await this.assertCallerActive(resourceKey, input);
      } catch (error) {
        markCallerFailed(error);
        throw error;
      }
      if (leaseLoss) throw leaseLoss;
      if (callerFailed) throw callerFailure;
      try {
        currentHandle = await this.assertOwned(currentHandle);
      } catch (error) {
        markLost(error);
        throw leaseLoss;
      }
      if (leaseLoss) throw leaseLoss;
      return currentHandle;
    };

    const context: OperationalLeaseExclusiveContext = {
      get handle() {
        return currentHandle;
      },
      signal: controller.signal,
      ensureActive,
      withFencedTransaction: async callback => {
        await ensureActive();
        return this.withFencedTransaction(currentHandle, callback);
      },
    };

    let primaryError: unknown;
    scheduleHeartbeat();
    try {
      await ensureActive();
      const result = await action(context);
      await stopHeartbeat();
      await ensureActive();
      return result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await stopHeartbeat();
      input.signal?.removeEventListener('abort', externalAbort);
      try {
        await this.release(currentHandle);
      } catch (releaseError) {
        if (primaryError === undefined) throw releaseError;
      }
    }
  }

  private async assertOwnedWithClient(
    client: LeaseQueryClient,
    handle: OperationalLeaseHandle,
    lockRow: boolean,
  ): Promise<LeaseRow> {
    const lock = lockRow ? Prisma.sql`FOR UPDATE` : Prisma.empty;
    const rows = await client.$queryRaw<LeaseRow[]>(Prisma.sql`
      SELECT
        "resource_key" AS "resourceKey",
        "owner_token"::text AS "ownerToken",
        "owner_kind" AS "ownerKind",
        "owner_id" AS "ownerId",
        "fencing_token" AS "fencingToken",
        "acquired_at" AS "acquiredAt",
        "heartbeat_at" AS "heartbeatAt",
        "expires_at" AS "expiresAt"
      FROM "operational_lease"
      WHERE
        "resource_key" = ${handle.resourceKey}
        AND "owner_token" = ${handle.ownerToken}::uuid
        AND "fencing_token" = ${handle.fencingToken}
        AND "expires_at" > CURRENT_TIMESTAMP
      ${lock}
    `);
    if (!rows[0]) {
      throw this.lost(handle);
    }
    return rows[0];
  }

  private async assertCallerActive(
    resourceKey: string,
    input: Pick<OperationalLeaseExclusiveInput, 'ensureActive' | 'signal'>,
  ) {
    if (input.signal?.aborted) {
      throw new OperationalLeaseLostError(
        resourceKey,
        'Operational lease caller signal was aborted',
        undefined,
        input.signal.reason,
      );
    }
    if (!input.ensureActive) return;
    const active = await input.ensureActive();
    if (active === false) {
      throw new OperationalLeaseLostError(
        resourceKey,
        'Operational lease caller is no longer active',
      );
    }
  }

  private delay(
    milliseconds: number,
    signal: AbortSignal | undefined,
    resourceKey: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new OperationalLeaseLostError(
            resourceKey,
            'Operational lease wait was aborted',
            undefined,
            signal.reason,
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(
          new OperationalLeaseLostError(
            resourceKey,
            'Operational lease wait was aborted',
            undefined,
            signal?.reason,
          ),
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private toHandle(row: LeaseRow, ttlMs: number): OperationalLeaseHandle {
    return Object.freeze({
      resourceKey: row.resourceKey,
      ownerToken: row.ownerToken,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      fencingToken:
        typeof row.fencingToken === 'bigint'
          ? row.fencingToken
          : BigInt(row.fencingToken),
      acquiredAt: this.toDate(row.acquiredAt, 'acquiredAt'),
      heartbeatAt: this.toDate(row.heartbeatAt, 'heartbeatAt'),
      expiresAt: this.toDate(row.expiresAt, 'expiresAt'),
      ttlMs,
    });
  }

  private lost(
    handle: OperationalLeaseHandle,
    message?: string,
    cause?: unknown,
  ) {
    return new OperationalLeaseLostError(
      handle.resourceKey,
      message,
      handle,
      cause,
    );
  }

  private requireValue(value: string, name: string) {
    const normalized = value?.trim();
    if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
    return normalized;
  }

  private assertCatalogReservation(resourceKey: string, ownerKind: string) {
    if (!resourceKey.startsWith('catalog-write:') || ownerKind === 'upc-activity-price') return;
    const liveEnabled = this.config
      ?.get<string>('UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED', 'false')
      .trim()
      .toLowerCase() === 'true';
    if (!liveEnabled) return;
    const appShopId = resourceKey.slice(resourceKey.lastIndexOf(':') + 1);
    const reserved = new Set(
      this.config
        ?.get<string>('UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST', '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean) ?? [],
    );
    if (reserved.has(appShopId)) {
      throw new OperationalLeaseUnavailableError(
        resourceKey,
        0,
      );
    }
  }

  private positiveInteger(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private nonNegativeInteger(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
  }

  private toDate(value: Date | string, name: string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`Operational lease returned invalid ${name}`);
    }
    return date;
  }
}
