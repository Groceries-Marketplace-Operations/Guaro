import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  BadGatewayException,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  Country,
  DidiOrderWebhookProfitMode,
  DidiOrderWebhookShopResolutionSource,
  Prisma,
} from '@prisma/client';
import { ApplicationsService } from '../src/applications/applications.service';
import { decrypt, encrypt } from '../src/common/crypto.util';
import { redactSensitiveRequestUrl } from '../src/common/filters/global-error.filter';
import {
  buildDidiOrderConfirmBody,
  DIDI_ORDER_ACCEPTANCE_TIMEOUT_MS,
  DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES,
  DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS,
  DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS,
  DidiOrderWebhooksService,
  parseDidiOrderWebhookPayload,
} from '../src/didi-order-webhooks/didi-order-webhooks.service';
import { fetchShopIdMap } from '../src/queue/handlers/didi-food.util';

const KEY = '42'.repeat(32);
const TOKEN = 'A'.repeat(43);
const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
// Exact 64-bit identifiers from the representative DiDi orderNew payload.
const APP_ID = '5764607584567296012';
const APP_SHOP_ID = '7093';
const REMOTE_SHOP_ID = '5764607688097661019';
const ORDER_ID = '1152921547153933576';
const SECRET = 'test-secret-never-real';

function payload(options: {
  appId?: string;
  appShopId?: string;
  nestedAppShopId?: string;
  orderId?: string;
  nestedOrderId?: string;
  type?: string;
  shopId?: string;
  priceJson?: string;
  omitRootAppShopId?: boolean;
  omitNestedAppShopId?: boolean;
} = {}) {
  const appId = options.appId ?? APP_ID;
  const appShopId = options.appShopId ?? APP_SHOP_ID;
  const nestedAppShopId = options.nestedAppShopId ?? appShopId;
  const orderId = options.orderId ?? ORDER_ID;
  const nestedOrderId = options.nestedOrderId ?? orderId;
  const rootShopField = options.omitRootAppShopId
    ? ''
    : `,"app_shop_id":${JSON.stringify(appShopId)}`;
  const nestedShopFields = [
    ...(options.omitNestedAppShopId
      ? []
      : [`"app_shop_id":${JSON.stringify(nestedAppShopId)}`]),
    ...(options.shopId ? [`"shop_id":${options.shopId}`] : []),
  ].join(',');
  const priceField = options.priceJson === undefined
    ? ''
    : `,"price":${options.priceJson}`;
  return Buffer.from(
    `{"app_id":${appId}${rootShopField},`
      + `"timestamp":1770000000000,"type":${JSON.stringify(options.type ?? 'orderNew')},`
      + `"data":{"order_id":${orderId},"order_info":{"order_id":${nestedOrderId},`
      + `"shop":{${nestedShopFields}}${priceField}}}}`,
    'utf8',
  );
}

test('raw webhook parsing preserves 64-bit app and order IDs exactly', () => {
  const parsed = parseDidiOrderWebhookPayload(payload());
  assert.deepEqual(parsed, {
    appId: APP_ID,
    appShopId: APP_SHOP_ID,
    orderId: ORDER_ID,
    type: 'orderNew',
    sourceTimestamp: '1770000000000',
    orderPriceMinor: null,
    realPriceMinor: null,
    realPayPriceMinor: null,
  });
  assert.notEqual(parsed.orderId, String(Number(ORDER_ID)));
});

test('raw webhook parsing rejects mismatched nested identifiers and non-order events', () => {
  assert.throws(
    () => parseDidiOrderWebhookPayload(payload({ nestedOrderId: '1152921547153933577' })),
    BadRequestException,
  );
  assert.throws(
    () => parseDidiOrderWebhookPayload(payload({ nestedAppShopId: 'another-shop' })),
    BadRequestException,
  );
  assert.throws(
    () => parseDidiOrderWebhookPayload(payload({ type: 'orderUpdate' })),
    BadRequestException,
  );
  assert.throws(
    () => parseDidiOrderWebhookPayload(payload({ type: ' orderNew ' })),
    BadRequestException,
  );
  assert.throws(
    () => parseDidiOrderWebhookPayload(Buffer.from(
      '{"app_id":1,"data":{"type":"orderNew"}}',
    )),
    BadRequestException,
  );
});

test('raw webhook parsing preserves shop_id when app_shop_id is absent', () => {
  assert.deepEqual(
    parseDidiOrderWebhookPayload(payload({
      omitRootAppShopId: true,
      omitNestedAppShopId: true,
      shopId: REMOTE_SHOP_ID,
    })),
    {
      appId: APP_ID,
      shopId: REMOTE_SHOP_ID,
      orderId: ORDER_ID,
      type: 'orderNew',
      sourceTimestamp: '1770000000000',
      orderPriceMinor: null,
      realPriceMinor: null,
      realPayPriceMinor: null,
    },
  );
  assert.throws(
    () => parseDidiOrderWebhookPayload(payload({
      omitRootAppShopId: true,
      omitNestedAppShopId: true,
    })),
    BadRequestException,
  );
});

test('raw webhook parsing captures all three optional price amounts as exact minor units', () => {
  const parsed = parseDidiOrderWebhookPayload(payload({
    priceJson: '{"order_price":"1234567890123456","real_price":2750,"real_pay_price":"2499"}',
  }));
  assert.equal(parsed.orderPriceMinor, 1_234_567_890_123_456n);
  assert.equal(parsed.realPriceMinor, 2_750n);
  assert.equal(parsed.realPayPriceMinor, 2_499n);
});

test('malformed optional price metadata becomes null instead of rejecting orderNew', () => {
  const malformedValues = parseDidiOrderWebhookPayload(payload({
    priceJson: '{"order_price":-1,"real_price":"12.34","real_pay_price":"9223372036854775808"}',
  }));
  assert.equal(malformedValues.orderPriceMinor, null);
  assert.equal(malformedValues.realPriceMinor, null);
  assert.equal(malformedValues.realPayPriceMinor, null);

  const malformedBlock = parseDidiOrderWebhookPayload(payload({ priceJson: '"not-an-object"' }));
  assert.equal(malformedBlock.orderPriceMinor, null);
  assert.equal(malformedBlock.realPriceMinor, null);
  assert.equal(malformedBlock.realPayPriceMinor, null);
});

test('receiver enforces its own 1 MiB raw-body limit', () => {
  assert.throws(
    () => parseDidiOrderWebhookPayload(Buffer.alloc(DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES + 1)),
    PayloadTooLargeException,
  );
});

test('confirm body emits the validated int64 as an exact JSON numeric literal', () => {
  const body = buildDidiOrderConfirmBody('token"value', ORDER_ID);
  assert.equal(body, `{"auth_token":"token\\"value","order_id":${ORDER_ID}}`);
  assert.ok(body.includes(`"order_id":${ORDER_ID}`));
  assert.throws(() => buildDidiOrderConfirmBody('token', '1,"admin":true'));
});

test('second-acceptance migration backfills accepted events and constrains the dedicated counter', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20261014235000_didi_order_webhook_second_acceptance/migration.sql',
  ), 'utf8');
  assert.match(migration, /ADD COLUMN "accepted_count" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /SET "accepted_count" = 1\s+WHERE "status" = 'accepted'/);
  assert.match(migration, /CHECK \("accepted_count" >= 0 AND "accepted_count" <= 2\)/);
  assert.match(migration, /CHECK \("type" = 'orderNew'\) NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT "didi_order_webhook_event_order_new_type_check"/);
});

test('resolution-source migrations stay compatible with the previous writer during rollout', () => {
  const sourceMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20261015010000_didi_order_webhook_resolution_sources/migration.sql',
  ), 'utf8');
  const consistencyMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20261015011000_didi_order_webhook_resolution_consistency/migration.sql',
  ), 'utf8');
  assert.match(sourceMigration, /DEFAULT 'local'/);
  assert.doesNotMatch(sourceMigration, /UPDATE "didi_order_webhook_(?:event|request)"/i);
  assert.doesNotMatch(sourceMigration, /ADD CONSTRAINT[\s\S]+shop_resolution_check/i);
  assert.doesNotMatch(consistencyMigration, /UPDATE "didi_order_webhook_request"/i);
  assert.doesNotMatch(consistencyMigration, /ADD CONSTRAINT/i);
});

test('payload-resolution migration permits an unvalidated payload without weakening other sources', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20261016023000_didi_order_webhook_payload_resolution_check/migration.sql',
  ), 'utf8');
  assert.match(
    migration,
    /"shop_id" IS NOT NULL[\s\S]+"didi_shop_id" IS NOT NULL[\s\S]+"remote_shop_validated" = true[\s\S]+"shop_resolution_source" = 'payload'/,
  );
  assert.match(migration, /shop_resolution_payload_check[\s\S]+NOT VALID/);
  assert.match(migration, /BEGIN;[\s\S]+SET LOCAL lock_timeout = '5s'/);
  assert.match(migration, /SET LOCAL statement_timeout = '2min'/);
  assert.equal(migration.match(/^BEGIN;$/gm)?.length, 3);
  assert.equal(migration.match(/^COMMIT;$/gm)?.length, 3);
  assert.equal(migration.match(/^SET LOCAL lock_timeout = '5s';$/gm)?.length, 3);
  assert.match(migration, /VALIDATE CONSTRAINT "didi_order_webhook_event_shop_resolution_payload_check"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "didi_order_webhook_event_shop_resolution_check"/);
  assert.match(
    migration,
    /RENAME CONSTRAINT "didi_order_webhook_event_shop_resolution_payload_check"[\s\S]+TO "didi_order_webhook_event_shop_resolution_check"/,
  );
  assert.doesNotMatch(migration, /SET\s+"remote_shop_validated"/i);
});

test('confirmation budget migration is metadata-only and defers table validation', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20261016022000_didi_order_webhook_confirmation_budget/migration.sql',
  ), 'utf8');
  assert.match(migration, /ADD COLUMN "confirmation_calls" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /confirmation_calls_check[\s\S]+NOT VALID/);
  assert.doesNotMatch(migration, /UPDATE\s+"didi_order_webhook_event"/i);
});

interface ExistingEvent {
  id: string;
  status: 'processing' | 'accepted' | 'failed';
  appShopId: string;
  didiShopId: string | null;
  startedAt: Date;
  acceptedAt?: Date | null;
  failedAt?: Date | null;
  acceptedCount?: number;
  confirmationCalls?: number;
  profitMxn?: Prisma.Decimal | null;
  remoteShopValidated?: boolean;
  shopResolutionSource?: DidiOrderWebhookShopResolutionSource;
}

function receiver(options: {
  shops?: string[];
  shopResponses?: string[][];
  shopRecordResponses?: Array<Array<{
    id: string;
    shopId: string;
    appShopId: string;
  }>>;
  inventoryShops?: Array<{
    shopId: string;
    appShopId: string;
    applicationId?: string;
    published?: boolean;
  }>;
  existing?: ExistingEvent;
  createUniqueConflict?: boolean;
  finance?: {
    country?: Country;
    mode: DidiOrderWebhookProfitMode;
    value: string;
    nativeToMxnRate?: string;
    mxnPerUsdRate: string;
  };
  automaticSecond?: boolean;
  orderForwarding?: {
    persist(input: {
      applicationId: string;
      requestId: string;
      orderId: string;
      eventType: 'orderNew';
      rawBody: Buffer;
    }): Promise<string | null>;
    publish(deliveryId: string): void;
  };
} = {}) {
  let existing = options.existing
    ? {
        ...options.existing,
        acceptedAt: options.existing.acceptedAt
          ?? (options.existing.status === 'accepted' ? new Date() : null),
        failedAt: options.existing.failedAt
          ?? (options.existing.status === 'failed' ? new Date() : null),
        acceptedCount: options.existing.acceptedCount
          ?? (options.existing.status === 'accepted' ? 1 : 0),
        confirmationCalls: options.existing.confirmationCalls
          ?? options.existing.acceptedCount
          ?? (options.existing.status === 'accepted' ? 1 : 0),
        profitMxn: options.existing.profitMxn ?? null,
        remoteShopValidated: options.existing.remoteShopValidated ?? false,
        shopResolutionSource: options.existing.shopResolutionSource
          ?? DidiOrderWebhookShopResolutionSource.local,
      }
    : undefined;
  const updates: Array<Record<string, unknown>> = [];
  const requestUpdates: Array<Record<string, unknown>> = [];
  const requestCreates: Array<Record<string, unknown>> = [];
  const eventCreates: Array<Record<string, unknown>> = [];
  const applicationFindCalls: unknown[] = [];
  const shopFindCalls: unknown[] = [];
  const inventoryFindCalls: unknown[] = [];
  const rawQueries: string[] = [];
  let transactions = 0;
  let ambiguousBarrierWaits = 0;
  let shopFindIndex = 0;
  const prisma = {
    application: {
      findFirst: async (input: unknown) => {
        applicationFindCalls.push(input);
        return {
          id: APPLICATION_ID,
          appId: APP_ID,
          appSecret: encrypt(SECRET, KEY),
          country: options.finance?.country ?? Country.MX,
          orderWebhookProfitMode: options.finance?.mode ?? null,
          orderWebhookProfitValue: options.finance
            ? new Prisma.Decimal(options.finance.value)
            : null,
          orderWebhookNativeToMxn: options.finance?.nativeToMxnRate
            ? new Prisma.Decimal(options.finance.nativeToMxnRate)
            : null,
          orderWebhookMxnPerUsd: options.finance
            ? new Prisma.Decimal(options.finance.mxnPerUsdRate)
            : null,
        };
      },
    },
    shop: {
      findMany: async (input: unknown) => {
        shopFindCalls.push(input);
        const responseIndex = shopFindIndex++;
        const records = options.shopRecordResponses?.[responseIndex];
        const ids = options.shopResponses?.[responseIndex] ?? options.shops ?? [SHOP_ID];
        return records
          ?? ids.map(id => ({ id, shopId: REMOTE_SHOP_ID, appShopId: APP_SHOP_ID }));
      },
    },
    applicationShopInventoryShop: {
      findMany: async (input: unknown) => {
        inventoryFindCalls.push(input);
        const query = input as {
          where?: {
            inventory?: { applicationId?: string; lastSuccessfulFetchAt?: { not?: null } };
            OR?: Array<{ shopId?: string; appShopId?: string }>;
          };
        };
        const applicationId = query.where?.inventory?.applicationId;
        const requiresPublished = query.where?.inventory?.lastSuccessfulFetchAt?.not === null;
        return (options.inventoryShops ?? [])
          .filter(candidate => (candidate.applicationId ?? APPLICATION_ID) === applicationId)
          .filter(candidate => !requiresPublished || candidate.published !== false)
          .filter(candidate => (query.where?.OR ?? []).some(condition =>
            (condition.shopId !== undefined && condition.shopId === candidate.shopId)
              || (condition.appShopId !== undefined && condition.appShopId === candidate.appShopId)))
          .map(({ shopId, appShopId }) => ({ shopId, appShopId }));
      },
    },
    didiOrderWebhookRequest: {
      create: async (input: { data: Record<string, unknown> }) => {
        requestCreates.push(input.data);
        return { id: `request-${requestCreates.length}` };
      },
      update: async (input: { data: Record<string, unknown> }) => {
        requestUpdates.push(input.data);
        return { id: 'request-1', ...input.data };
      },
    },
    didiOrderWebhookEvent: {
      create: async (input: { data: Record<string, unknown> }) => {
        eventCreates.push(input.data);
        if (options.createUniqueConflict || existing) throw { code: 'P2002' };
        existing = {
          id: 'event-1',
          status: 'processing',
          appShopId: APP_SHOP_ID,
          didiShopId: String(input.data.didiShopId),
          startedAt: new Date(),
          acceptedAt: null,
          failedAt: null,
          acceptedCount: 0,
          confirmationCalls: 0,
          profitMxn: input.data.profitMxn as Prisma.Decimal | null,
          remoteShopValidated: Boolean(input.data.remoteShopValidated),
          shopResolutionSource: input.data.shopResolutionSource as DidiOrderWebhookShopResolutionSource,
        };
        return {
          id: existing.id,
          status: existing.status,
          appShopId: existing.appShopId,
          didiShopId: existing.didiShopId,
          acceptedCount: existing.acceptedCount,
          confirmationCalls: existing.confirmationCalls,
          profitMxn: existing.profitMxn,
        };
      },
      findUnique: async () => existing
        ? {
            ...existing,
            shop: existing.didiShopId === null ? { shopId: REMOTE_SHOP_ID } : null,
          }
        : null,
      updateMany: async (input: {
        where: {
          status: string;
          startedAt?: { lt: Date };
          acceptedCount?: number | { lt: number };
          confirmationCalls?: number | { lt: number };
          failedAt?: { lte: Date };
        };
        data: Record<string, unknown>;
      }) => {
        if (!existing || existing.status !== input.where.status) return { count: 0 };
        if (input.where.startedAt && existing.startedAt >= input.where.startedAt.lt) return { count: 0 };
        if (typeof input.where.acceptedCount === 'number'
          && existing.acceptedCount !== input.where.acceptedCount) return { count: 0 };
        if (typeof input.where.acceptedCount === 'object'
          && (existing.acceptedCount ?? 0) >= input.where.acceptedCount.lt) return { count: 0 };
        if (input.where.confirmationCalls
          && typeof input.where.confirmationCalls === 'number'
          && (existing.confirmationCalls ?? 0) !== input.where.confirmationCalls) return { count: 0 };
        if (input.where.confirmationCalls
          && typeof input.where.confirmationCalls === 'object'
          && (existing.confirmationCalls ?? 0) >= input.where.confirmationCalls.lt) return { count: 0 };
        if (input.where.failedAt
          && (!existing.failedAt || existing.failedAt > input.where.failedAt.lte)) return { count: 0 };
        const nextStatus = typeof input.data.status === 'string'
          ? input.data.status as ExistingEvent['status']
          : existing.status;
        existing = {
          ...existing,
          status: nextStatus,
          startedAt: new Date(),
          ...(input.data.failedAt instanceof Date || input.data.failedAt === null
            ? { failedAt: input.data.failedAt }
            : {}),
        };
        updates.push(input.data);
        return { count: 1 };
      },
      update: async (input: { data: Record<string, unknown> }) => {
        updates.push(input.data);
        if (existing) {
          existing = {
            ...existing,
            ...(typeof input.data.status === 'string'
              ? { status: input.data.status as ExistingEvent['status'] }
              : {}),
            ...(typeof input.data.appShopId === 'string'
              ? { appShopId: input.data.appShopId }
              : {}),
            ...(typeof input.data.didiShopId === 'string'
              ? { didiShopId: input.data.didiShopId }
              : {}),
            ...(typeof input.data.remoteShopValidated === 'boolean'
              ? { remoteShopValidated: input.data.remoteShopValidated }
              : {}),
            ...(typeof input.data.shopResolutionSource === 'string'
              ? { shopResolutionSource: input.data.shopResolutionSource as DidiOrderWebhookShopResolutionSource }
              : {}),
          };
        }
        return existing;
      },
    },
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      rawQueries.push(sql);
      if (!existing) return [];
      if (sql.includes('"confirmation_calls" - 1')) {
        if (existing.status !== 'processing'
          || (existing.confirmationCalls ?? 0) <= (existing.acceptedCount ?? 0)) return [];
        existing = {
          ...existing,
          confirmationCalls: Math.max(
            existing.acceptedCount ?? 0,
            (existing.confirmationCalls ?? 0) - 1,
          ),
        };
        return [{ confirmationCall: existing.confirmationCalls }];
      }
      if (sql.includes('"confirmation_calls" = GREATEST')) {
        const effectiveCalls = Math.max(
          existing.confirmationCalls ?? 0,
          existing.acceptedCount ?? 0,
        );
        if (existing.status !== 'processing' || effectiveCalls >= 2) return [];
        existing = { ...existing, confirmationCalls: effectiveCalls + 1 };
        return [{ confirmationCall: existing.confirmationCalls }];
      }
      if (sql.includes('"accepted_count" = "accepted_count" + 1')) {
        if (existing.status !== 'processing'
          || (existing.acceptedCount ?? 0) >= 2
          || (existing.confirmationCalls ?? 0) <= (existing.acceptedCount ?? 0)) return [];
        existing = {
          ...existing,
          status: 'accepted',
          acceptedCount: (existing.acceptedCount ?? 0) + 1,
          acceptedAt: new Date(),
          failedAt: null,
        };
        updates.push({
          status: 'accepted',
          acceptedCount: existing.acceptedCount,
          remoteErrno: 0,
        });
        return [{ acceptedCount: existing.acceptedCount }];
      }
      if (sql.includes('"accepted_at" <= CURRENT_TIMESTAMP')) {
        const eligibleBefore = Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS;
        if (existing.status !== 'accepted'
          || existing.acceptedCount !== 1
          || Math.max(existing.confirmationCalls ?? 0, existing.acceptedCount ?? 0) >= 2
          || !existing.acceptedAt
          || existing.acceptedAt.getTime() > eligibleBefore) return [];
        existing = { ...existing, status: 'processing', startedAt: new Date() };
        return [{
          id: existing.id,
          status: 'processing',
          appShopId: existing.appShopId,
          didiShopId: existing.didiShopId,
          acceptedCount: existing.acceptedCount,
          confirmationCalls: existing.confirmationCalls,
          profitMxn: existing.profitMxn,
        }];
      }
      return [];
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      return callback(prisma);
    },
  };
  const config = { getOrThrow: () => KEY };
  const value = new DidiOrderWebhooksService(
    prisma as never,
    config as never,
    undefined,
    options.orderForwarding as never,
  );
  (value as unknown as {
    waitForAutomaticSecondAcceptance: (deadlineAt: number) => Promise<boolean>;
  }).waitForAutomaticSecondAcceptance = async () => {
    if (!options.automaticSecond) return false;
    if (existing) {
      existing.acceptedAt = new Date(
        Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS - 1,
      );
    }
    return true;
  };
  (value as unknown as {
    waitForAmbiguousRetryBarrier: (
      failedAt: Date,
      acceptanceDeadlineAt: number,
    ) => Promise<void>;
  }).waitForAmbiguousRetryBarrier = async () => {
    ambiguousBarrierWaits += 1;
    if (existing) {
      existing.failedAt = new Date(
        Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS - 1,
      );
    }
  };
  return {
    value,
    updates,
    requestUpdates,
    requestCreates,
    eventCreates,
    applicationFindCalls,
    shopFindCalls,
    inventoryFindCalls,
    rawQueries,
    transactions: () => transactions,
    ambiguousBarrierWaits: () => ambiguousBarrierWaits,
    currentEvent: () => existing,
  };
}

test('receiver gets the shop token and confirms once with the exact order ID', async () => {
  const subject = receiver();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-value' } }));
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'access-value' } }));
    }
    assert.ok(url.endsWith('/v1/order/order/confirm'));
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload());
    assert.deepEqual(result, {
      accepted: true,
      deduplicated: false,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'accepted',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, 'https://openapi.didi-food.com/v1/order/order/confirm');
  assert.equal(
    calls[2].init?.body,
    `{"auth_token":"access-value","order_id":${ORDER_ID}}`,
  );
  assert.equal(subject.updates.at(-1)?.status, 'accepted');
  assert.equal(subject.updates.at(-1)?.remoteErrno, 0);
  assert.equal(subject.requestUpdates.at(-1)?.outcome, 'accepted');
  assert.equal(subject.requestUpdates.at(-1)?.localHttpStatus, 200);
  assert.equal(subject.transactions(), 1);
  assert.equal(subject.currentEvent()?.confirmationCalls, 1);
});

test('one delivery automatically performs the second confirmation after the delay', async () => {
  const subject = receiver({
    automaticSecond: true,
    finance: {
      mode: DidiOrderWebhookProfitMode.fixed_mxn,
      value: '7.50',
      mxnPerUsdRate: '20',
    },
  });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload());
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 2);
  assert.equal(subject.currentEvent()?.acceptedCount, 2);
  assert.equal(subject.currentEvent()?.confirmationCalls, 2);
  assert.equal(subject.transactions(), 2);
  assert.equal(subject.requestUpdates.at(-1)?.profitRecognized, true);
});

test('an explicit automatic-second rejection preserves the first success and can retry later', async () => {
  const subject = receiver({ automaticSecond: true });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify(confirmations === 2
      ? { errno: 20001, errmsg: 'explicit rejection' }
      : { errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const first = await subject.value.receive(TOKEN, payload());
    assert.equal(first.accepted, true);
    assert.equal(subject.currentEvent()?.status, 'accepted');
    assert.equal(subject.currentEvent()?.acceptedCount, 1);
    assert.equal(subject.currentEvent()?.confirmationCalls, 1);

    const retried = await subject.value.receive(TOKEN, payload());
    assert.equal(retried.accepted, true);
    assert.equal(retried.deduplicated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 3);
  assert.equal(subject.currentEvent()?.acceptedCount, 2);
  assert.equal(subject.currentEvent()?.confirmationCalls, 2);
});

test('an ambiguous automatic-second failure consumes the safety budget without undoing success', async () => {
  const subject = receiver({ automaticSecond: true });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return confirmations === 2
      ? new Response('not-json', { status: 503 })
      : new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const first = await subject.value.receive(TOKEN, payload());
    assert.equal(first.accepted, true);
    assert.equal(subject.currentEvent()?.status, 'accepted');
    assert.equal(subject.currentEvent()?.acceptedCount, 1);
    assert.equal(subject.currentEvent()?.confirmationCalls, 2);

    const later = await subject.value.receive(TOKEN, payload());
    assert.equal(later.deduplicated, true);
    assert.equal(later.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 2);
});

test('malformed price metadata never blocks confirmation and is persisted as null', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({
      shopId: REMOTE_SHOP_ID,
      priceJson: '{"order_price":{},"real_price":2.5,"real_pay_price":"invalid"}',
    }));
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 1);
  assert.equal(subject.eventCreates[0]?.orderPriceMinor, null);
  assert.equal(subject.eventCreates[0]?.realPriceMinor, null);
  assert.equal(subject.eventCreates[0]?.realPayPriceMinor, null);
});

test('a canonical event is durably persisted and published with the exact body', async () => {
  const forwarded: Array<{
    applicationId: string;
    requestId: string;
    orderId: string;
    eventType: 'orderNew';
    rawBody: Buffer;
  }> = [];
  const published: string[] = [];
  const subject = receiver({
    orderForwarding: {
      persist: async input => {
        forwarded.push(input);
        return 'delivery-1';
      },
      publish: deliveryId => { published.push(deliveryId); },
    },
  });
  const exactBody = payload();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, exactBody);
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].applicationId, APPLICATION_ID);
  assert.equal(forwarded[0].requestId, 'request-1');
  assert.equal(forwarded[0].orderId, ORDER_ID);
  assert.equal(forwarded[0].eventType, 'orderNew');
  assert.equal(forwarded[0].rawBody, exactBody);
  assert.deepEqual(published, ['delivery-1']);
});

test('receiver waits for durable forwarding persistence before shop resolution', async () => {
  let releasePersistence!: (deliveryId: string | null) => void;
  let markPersistenceStarted!: () => void;
  const persistenceStarted = new Promise<void>(resolve => { markPersistenceStarted = resolve; });
  const pendingPersistence = new Promise<string | null>(resolve => { releasePersistence = resolve; });
  const published: string[] = [];
  const subject = receiver({
    orderForwarding: {
      persist: () => {
        markPersistenceStarted();
        return pendingPersistence;
      },
      publish: deliveryId => { published.push(deliveryId); },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const receivePromise = subject.value.receive(TOKEN, payload());
    await persistenceStarted;
    assert.equal(subject.shopFindCalls.length, 0);
    releasePersistence('delivery-waited');
    const result = await receivePromise;
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(published, ['delivery-waited']);
});

test('a valid canonical event is relayed even when local shop resolution fails', async () => {
  const forwarded: Buffer[] = [];
  const subject = receiver({
    shops: [],
    orderForwarding: {
      persist: async input => {
        forwarded.push(input.rawBody);
        return 'delivery-1';
      },
      publish: () => undefined,
    },
  });
  const exactBody = payload();

  await assert.rejects(subject.value.receive(TOKEN, exactBody), BadRequestException);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0], exactBody);
  assert.equal(subject.eventCreates.length, 0);
});

test('invalid event types and mismatched App IDs are never persisted for relay', async () => {
  let persistCalls = 0;
  const subject = receiver({
    orderForwarding: {
      persist: async () => {
        persistCalls += 1;
        return 'delivery-1';
      },
      publish: () => undefined,
    },
  });

  await assert.rejects(
    subject.value.receive(TOKEN, payload({ type: 'orderUpdate' })),
    BadRequestException,
  );
  await assert.rejects(
    subject.value.receive(TOKEN, payload({ appId: '5764607584567296013' })),
    BadRequestException,
  );
  assert.equal(persistCalls, 0);
});

test('a relay persistence failure never changes successful DiDi confirmation', async () => {
  let persistCalls = 0;
  const subject = receiver({
    orderForwarding: {
      persist: async () => {
        persistCalls += 1;
        throw new Error('relay unavailable');
      },
      publish: () => undefined,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload());
    assert.equal(result.accepted, true);
    assert.equal(result.status, 'accepted');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(persistCalls, 1);
  assert.equal(subject.updates.at(-1)?.status, 'accepted');
});

test('a relay publication failure never changes successful DiDi confirmation', async () => {
  const subject = receiver({
    orderForwarding: {
      persist: async () => 'delivery-1',
      publish: () => { throw new Error('queue unavailable'); },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload());
    assert.equal(result.accepted, true);
    assert.equal(result.status, 'accepted');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(subject.updates.at(-1)?.status, 'accepted');
});

test('receiver resolves a missing app_shop_id from the application shop list', async () => {
  const subject = receiver({ shops: [] });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/shop/shop/list')) {
      assert.deepEqual(subject.requestUpdates.at(-1), {
        stage: 'shop_resolution',
        appShopId: null,
        didiShopId: REMOTE_SHOP_ID,
        orderId: ORDER_ID,
        type: 'orderNew',
      });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(request.app_id, APP_ID);
      assert.equal(request.page_no, 1);
      assert.equal(typeof request.sign, 'string');
      assert.equal(JSON.stringify(request).includes(SECRET), false);
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          total: 1,
          shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID }],
        },
      }));
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      assert.equal(new URL(url).searchParams.get('app_shop_id'), APP_SHOP_ID);
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-value' } }));
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'access-value' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({
      omitRootAppShopId: true,
      omitNestedAppShopId: true,
      shopId: REMOTE_SHOP_ID,
    }));
    assert.deepEqual(result, {
      accepted: true,
      deduplicated: false,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'accepted',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://openapi.didi-food.com/v1/shop/shop/list');
  assert.deepEqual(subject.shopFindCalls.at(-1), {
    where: {
      shopId: REMOTE_SHOP_ID,
      appShopId: APP_SHOP_ID,
      deletedAt: null,
      brand: { applicationId: APPLICATION_ID, deletedAt: null },
    },
    select: { id: true, shopId: true, appShopId: true },
    take: 2,
  });
  const resolutionAudit = subject.requestUpdates.find(update => update.appShopId === APP_SHOP_ID);
  assert.equal(resolutionAudit?.appShopId, APP_SHOP_ID);
});

test('receiver enriches a complete webhook shop pair with its exact active local mapping', async () => {
  const subject = receiver({
    shopRecordResponses: [[{
      id: SHOP_ID,
      shopId: REMOTE_SHOP_ID,
      appShopId: APP_SHOP_ID,
    }]],
  });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/shop/shop/list')) {
      throw new Error('a complete webhook pair must not scan the shop list');
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({ shopId: REMOTE_SHOP_ID }));
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.filter(url => url.endsWith('/v1/shop/shop/list')).length, 0);
  assert.deepEqual(subject.shopFindCalls, [{
    where: {
      shopId: REMOTE_SHOP_ID,
      appShopId: APP_SHOP_ID,
      deletedAt: null,
      brand: { applicationId: APPLICATION_ID, deletedAt: null },
    },
    select: { id: true, shopId: true, appShopId: true },
    take: 2,
  }]);
  assert.equal(subject.inventoryFindCalls.length, 0);
  assert.equal(subject.eventCreates[0]?.shopId, SHOP_ID);
  assert.equal(subject.eventCreates[0]?.didiShopId, REMOTE_SHOP_ID);
  assert.equal(subject.eventCreates[0]?.appShopId, APP_SHOP_ID);
  assert.equal(subject.eventCreates[0]?.remoteShopValidated, false);
  assert.equal(
    subject.eventCreates[0]?.shopResolutionSource,
    DidiOrderWebhookShopResolutionSource.local,
  );
});

test('receiver confirms a remotely verified shop even when it is absent locally', async () => {
  const subject = receiver({ shopResponses: [[], []] });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          total: 1,
          shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID }],
        },
      }));
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      assert.equal(new URL(url).searchParams.get('app_shop_id'), APP_SHOP_ID);
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({
      omitRootAppShopId: true,
      omitNestedAppShopId: true,
      shopId: REMOTE_SHOP_ID,
    }));
    assert.deepEqual(result, {
      accepted: true,
      deduplicated: false,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'accepted',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.filter(url => url.endsWith('/v1/shop/shop/list')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/v1/order/order/confirm')).length, 1);
  assert.equal(subject.eventCreates[0]?.applicationId, APPLICATION_ID);
  assert.equal(subject.eventCreates[0]?.shopId, null);
  assert.equal(subject.eventCreates[0]?.didiShopId, REMOTE_SHOP_ID);
  assert.equal(subject.eventCreates[0]?.appShopId, APP_SHOP_ID);
  assert.equal(subject.eventCreates[0]?.remoteShopValidated, true);
  assert.equal(
    subject.eventCreates[0]?.shopResolutionSource,
    DidiOrderWebhookShopResolutionSource.remote,
  );
  assert.ok(subject.requestUpdates.some(update =>
    update.didiShopId === REMOTE_SHOP_ID && update.remoteShopValidated === true));
});

test('receiver confirms a complete payload pair without requiring a local Shop', async () => {
  const subject = receiver({ shopResponses: [[]] });
  const originalFetch = globalThis.fetch;
  let confirms = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          total: 1,
          shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID }],
        },
      }));
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirms += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({ shopId: REMOTE_SHOP_ID }));
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirms, 1);
  assert.equal(subject.shopFindCalls.length, 1);
  assert.equal(subject.eventCreates[0]?.shopId, null);
  assert.equal(subject.eventCreates[0]?.didiShopId, REMOTE_SHOP_ID);
  assert.equal(subject.eventCreates[0]?.remoteShopValidated, false);
  assert.equal(
    subject.eventCreates[0]?.shopResolutionSource,
    DidiOrderWebhookShopResolutionSource.payload,
  );
});

test('remote shop resolution single-flights concurrent calls and reuses the signed mapping cache', async () => {
  const subject = receiver({ shops: [] });
  const originalFetch = globalThis.fetch;
  let shopListCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.ok(String(input).endsWith('/v1/shop/shop/list'));
    shopListCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({
      errno: 0,
      data: {
        total: 1,
        shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID }],
      },
    }));
  }) as typeof fetch;
  const resolveRemote = (
    subject.value as unknown as {
      resolveRemoteAppShopId: (
        applicationId: string,
        appId: string,
        appSecret: string,
        shopId: string,
      ) => Promise<string | undefined>;
    }
  ).resolveRemoteAppShopId.bind(subject.value);
  try {
    const [first, second] = await Promise.all([
      resolveRemote(APPLICATION_ID, APP_ID, SECRET, REMOTE_SHOP_ID),
      resolveRemote(APPLICATION_ID, APP_ID, SECRET, REMOTE_SHOP_ID),
    ]);
    const cached = await resolveRemote(APPLICATION_ID, APP_ID, SECRET, REMOTE_SHOP_ID);
    assert.equal(first, APP_SHOP_ID);
    assert.equal(second, APP_SHOP_ID);
    assert.equal(cached, APP_SHOP_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(shopListCalls, 1);
});

test('receiver does not trust an app_shop_id-only payload when the shop is absent locally', async () => {
  const subject = receiver({ shops: [] });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload()), BadRequestException);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(subject.eventCreates.length, 0);
});

test('receiver falls back to a remote app_shop_id after direct payload authentication fails', async () => {
  const subject = receiver({ shopResponses: [[]] });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetches += 1;
    const url = String(input);
    if (url.includes('/refresh')) {
      const selected = new URL(url).searchParams.get('app_shop_id');
      if (selected === APP_SHOP_ID) {
        return new Response(JSON.stringify({ errno: 20001, errmsg: 'invalid app shop' }));
      }
      assert.equal(selected, 'remote-value');
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      assert.equal(new URL(url).searchParams.get('app_shop_id'), 'remote-value');
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    if (url.endsWith('/v1/order/order/confirm')) {
      return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
    }
    return new Response(JSON.stringify({
      errno: 0,
      data: {
        total: 1,
        shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: 'remote-value' }],
      },
    }));
  }) as typeof fetch;
  try {
    const accepted = await subject.value.receive(
      TOKEN,
      payload({ shopId: REMOTE_SHOP_ID }),
    );
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.appShopId, 'remote-value');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(fetches >= 4);
  assert.equal(subject.shopFindCalls.length, 2);
  assert.equal(subject.requestUpdates.at(-1)?.outcome, 'accepted');
  assert.ok(subject.updates.some(update =>
    update.appShopId === 'remote-value'
      && update.shopResolutionSource === DidiOrderWebhookShopResolutionSource.remote));
});

test('an explicit payload-candidate confirmation rejection falls back to the local mapping', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  const confirmedTokens: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      const appShopId = new URL(url).searchParams.get('app_shop_id');
      return new Response(JSON.stringify({
        errno: 0,
        data: { refresh_token: `refresh-${appShopId}` },
      }));
    }
    if (url.includes('/get')) {
      const appShopId = new URL(url).searchParams.get('app_shop_id');
      return new Response(JSON.stringify({
        errno: 0,
        data: { auth_token: `auth-${appShopId}` },
      }));
    }
    const body = JSON.parse(String(init?.body)) as { auth_token: string };
    confirmedTokens.push(body.auth_token);
    return new Response(JSON.stringify(confirmedTokens.length === 1
      ? { errno: 20001, errmsg: 'shop does not match order' }
      : { errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({
      appShopId: 'payload-wrong',
      nestedAppShopId: 'payload-wrong',
      shopId: REMOTE_SHOP_ID,
    }));
    assert.equal(result.accepted, true);
    assert.equal(result.appShopId, APP_SHOP_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(confirmedTokens, ['auth-payload-wrong', `auth-${APP_SHOP_ID}`]);
  assert.equal(subject.currentEvent()?.confirmationCalls, 1);
  assert.ok(subject.updates.some(update =>
    update.shopResolutionSource === DidiOrderWebhookShopResolutionSource.local));
});

test('a 5xx confirmation outcome is ambiguous and never tries another shop candidate', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 20001, errmsg: 'upstream failure' }), {
      status: 503,
    });
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload({
      appShopId: 'payload-wrong',
      nestedAppShopId: 'payload-wrong',
      shopId: REMOTE_SHOP_ID,
    })), BadGatewayException);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 1);
  assert.equal(subject.shopFindCalls.length, 1);
  assert.equal(subject.inventoryFindCalls.length, 0);
  assert.equal(subject.currentEvent()?.confirmationCalls, 1);
});

test('an immediate redelivery waits out an ambiguous result and then uses only slot two', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return confirmations === 1
      ? new Response('ambiguous-upstream-body', { status: 503 })
      : new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  const body = payload({ shopId: REMOTE_SHOP_ID });
  try {
    await assert.rejects(subject.value.receive(TOKEN, body), BadGatewayException);
    assert.equal(subject.currentEvent()?.status, 'failed');
    assert.equal(subject.currentEvent()?.acceptedCount, 0);
    assert.equal(subject.currentEvent()?.confirmationCalls, 1);

    const retried = await subject.value.receive(TOKEN, body);
    assert.equal(retried.deduplicated, false);
    assert.equal(retried.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(subject.ambiguousBarrierWaits(), 1);
  assert.equal(confirmations, 2);
  assert.equal(subject.currentEvent()?.acceptedCount, 1);
  assert.equal(subject.currentEvent()?.confirmationCalls, 2);
});

test('concurrent redeliveries after an ambiguous result have one slot-two CAS winner', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-ambiguous-concurrent',
      status: 'failed',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(),
      failedAt: new Date(),
      acceptedCount: 0,
      confirmationCalls: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  const body = payload({ shopId: REMOTE_SHOP_ID });
  try {
    const results = await Promise.all([
      subject.value.receive(TOKEN, body),
      subject.value.receive(TOKEN, body),
    ]);
    assert.equal(results.filter(result => !result.deduplicated).length, 1);
    assert.equal(results.filter(result => result.deduplicated).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 1);
  assert.equal(subject.currentEvent()?.acceptedCount, 1);
  assert.equal(subject.currentEvent()?.confirmationCalls, 2);
});

test('missing app_shop_id fails closed when the remote shop is absent or ambiguous', async () => {
  for (const shopList of [
    [],
    [
      { shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID },
      { shop_id: REMOTE_SHOP_ID, app_shop_id: 'different-app-shop' },
    ],
  ]) {
    const subject = receiver({ shops: [] });
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        errno: 0,
        data: { total: shopList.length, shop_list: shopList },
      }));
    }) as typeof fetch;
    try {
      const request = subject.value.receive(TOKEN, payload({
        omitRootAppShopId: true,
        omitNestedAppShopId: true,
        shopId: REMOTE_SHOP_ID,
      }));
      if (shopList.length === 0) {
        await assert.rejects(request, BadRequestException);
      } else {
        await assert.rejects(request, BadGatewayException);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetches, 1);
    assert.equal(subject.shopFindCalls.length, 1);
    const audit = subject.requestUpdates.at(-1);
    assert.equal(audit?.stage, 'shop_resolution');
    assert.equal(audit?.outcome, shopList.length === 0 ? 'rejected' : 'failed');
    assert.equal(JSON.stringify(audit).includes(SECRET), false);
  }
});

test('shop-list fallback has bounded rate-limit retries and rejects non-2xx responses', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ errno: 10005, errmsg: 'too frequent' }), {
      status: 429,
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchShopIdMap(APP_ID, SECRET, [REMOTE_SHOP_ID], { maxRateLimitRetries: 0 }),
      /remained rate limited after 1 attempt/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 1);

  globalThis.fetch = (async () => new Response(JSON.stringify({
    errno: 0,
    data: { total: 0, shop_list: [] },
  }), { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      fetchShopIdMap(APP_ID, SECRET, [REMOTE_SHOP_ID], { maxRateLimitRetries: 0 }),
      /HTTP 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an accepted duplicate before ten seconds and a live processing duplicate never resend', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    const accepted = receiver({
      createUniqueConflict: true,
      existing: {
        id: 'event-a',
        status: 'accepted',
        appShopId: APP_SHOP_ID,
        didiShopId: REMOTE_SHOP_ID,
        startedAt: new Date(),
      },
    });
    assert.deepEqual(await accepted.value.receive(TOKEN, payload()), {
      accepted: true,
      deduplicated: true,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'accepted',
    });
    assert.equal(accepted.requestUpdates.at(-1)?.outcome, 'deduplicated');
    assert.equal(accepted.requestUpdates.at(-1)?.eventId, 'event-a');

    const processing = receiver({
      createUniqueConflict: true,
      existing: {
        id: 'event-p',
        status: 'processing',
        appShopId: APP_SHOP_ID,
        didiShopId: REMOTE_SHOP_ID,
        startedAt: new Date(),
      },
    });
    assert.deepEqual(await processing.value.receive(TOKEN, payload()), {
      accepted: false,
      deduplicated: true,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'processing',
    });
    assert.equal(processing.requestUpdates.at(-1)?.outcome, 'deduplicated');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test('processing events remain leased for the entire bounded acceptance window', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-live-deadline',
      status: 'processing',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(Date.now() - DIDI_ORDER_ACCEPTANCE_TIMEOUT_MS + 10_000),
      acceptedCount: 0,
      confirmationCalls: 0,
    },
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('a live processing event must not be reclaimed');
  }) as typeof fetch;
  try {
    const result = await subject.value.receive(TOKEN, payload({ shopId: REMOTE_SHOP_ID }));
    assert.equal(result.deduplicated, true);
    assert.equal(result.status, 'processing');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(subject.currentEvent()?.status, 'processing');
});

test('the same order is accepted a second time after ten seconds, then all later deliveries deduplicate', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-second',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(Date.now() - 20_000),
      acceptedAt: new Date(Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS - 1_000),
      acceptedCount: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const second = await subject.value.receive(TOKEN, payload());
    assert.equal(second.accepted, true);
    assert.equal(second.deduplicated, false);
    assert.equal(subject.currentEvent()?.acceptedCount, 2);
    assert.ok(subject.rawQueries.some(sql =>
      sql.includes('"accepted_at" <= CURRENT_TIMESTAMP')
      && sql.includes("INTERVAL '1 millisecond'")));

    const third = await subject.value.receive(TOKEN, payload());
    assert.deepEqual(third, {
      accepted: true,
      deduplicated: true,
      orderId: ORDER_ID,
      appShopId: APP_SHOP_ID,
      status: 'accepted',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 1);
});

test('profit is recognized only on the first successful acceptance request', async () => {
  const finance = {
    mode: DidiOrderWebhookProfitMode.fixed_mxn,
    value: '7.50',
    mxnPerUsdRate: '20',
  };
  const originalFetch = globalThis.fetch;
  let failConfirmation = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { total: 0, shop_list: [] },
      }));
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify(failConfirmation
      ? { errno: 10005, errmsg: 'temporary failure' }
      : { errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const first = receiver({ finance });
    await first.value.receive(TOKEN, payload());
    assert.equal(first.requestUpdates.at(-1)?.outcome, 'accepted');
    assert.equal(first.requestUpdates.at(-1)?.profitRecognized, true);

    const second = receiver({
      finance,
      createUniqueConflict: true,
      existing: {
        id: 'event-profit-second',
        status: 'accepted',
        appShopId: APP_SHOP_ID,
        didiShopId: REMOTE_SHOP_ID,
        startedAt: new Date(Date.now() - 20_000),
        acceptedAt: new Date(Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS - 1_000),
        acceptedCount: 1,
      },
    });
    await second.value.receive(TOKEN, payload());
    assert.equal(second.requestUpdates.at(-1)?.outcome, 'accepted');
    assert.equal(second.requestUpdates.at(-1)?.profitRecognized, false);

    const duplicate = receiver({
      finance,
      createUniqueConflict: true,
      existing: {
        id: 'event-profit-duplicate',
        status: 'accepted',
        appShopId: APP_SHOP_ID,
        didiShopId: REMOTE_SHOP_ID,
        startedAt: new Date(Date.now() - 20_000),
        acceptedAt: new Date(Date.now() - 20_000),
        acceptedCount: 2,
      },
    });
    await duplicate.value.receive(TOKEN, payload());
    assert.equal(duplicate.requestUpdates.at(-1)?.outcome, 'deduplicated');
    assert.equal(duplicate.requestUpdates.at(-1)?.profitRecognized, false);

    failConfirmation = true;
    const failure = receiver({ finance });
    await assert.rejects(failure.value.receive(TOKEN, payload()), BadGatewayException);
    assert.equal(failure.requestUpdates.at(-1)?.outcome, 'failed');
    assert.equal(failure.requestUpdates.at(-1)?.profitRecognized, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent deliveries eligible for the second acceptance have exactly one CAS winner', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-concurrent-second',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(Date.now() - 20_000),
      acceptedAt: new Date(Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS - 1_000),
      acceptedCount: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { total: 0, shop_list: [] },
      }));
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const results = await Promise.all([
      subject.value.receive(TOKEN, payload()),
      subject.value.receive(TOKEN, payload()),
    ]);
    assert.equal(results.filter(result => !result.deduplicated).length, 1);
    assert.equal(results.filter(result => result.deduplicated).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 1);
  assert.equal(subject.currentEvent()?.acceptedCount, 2);
});

test('a failed second confirmation preserves the first acceptance and a later delivery retries slot two', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-retry-second',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(Date.now() - 20_000),
      acceptedAt: new Date(Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS),
      acceptedCount: 1,
    },
  });
  const firstAcceptedAt = subject.currentEvent()?.acceptedAt;
  const originalFetch = globalThis.fetch;
  let confirmations = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { total: 0, shop_list: [] },
      }));
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    confirmations += 1;
    return new Response(JSON.stringify(confirmations === 1
      ? { errno: 10005, errmsg: 'temporary failure' }
      : { errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload()), BadGatewayException);
    assert.equal(subject.currentEvent()?.status, 'accepted');
    assert.equal(subject.currentEvent()?.acceptedCount, 1);
    assert.equal(subject.currentEvent()?.acceptedAt, firstAcceptedAt);

    const retried = await subject.value.receive(TOKEN, payload());
    assert.equal(retried.accepted, true);
    assert.equal(retried.deduplicated, false);
    assert.equal(subject.currentEvent()?.acceptedCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmations, 2);
});

test('a duplicate order_id for another DiDi shop_id is rejected before confirmation', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-conflict',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: '5764607688097661020',
      startedAt: new Date(),
    },
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload()), /another shop_id/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(subject.requestUpdates.at(-1)?.outcome, 'rejected');
});

test('a legacy duplicate with a null audit shop ID still verifies its local Shop mapping', async () => {
  const subject = receiver({
    existing: {
      id: 'event-legacy',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: null,
      startedAt: new Date(),
    },
    createUniqueConflict: true,
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('confirmation must not be called');
  }) as typeof fetch;
  try {
    await assert.rejects(
      subject.value.receive(TOKEN, payload({ shopId: '5764607688097661020' })),
      /order_id was previously received for another shop_id/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test('a rollout-window remote duplicate normalizes the legacy local default on read', async () => {
  const subject = receiver({
    existing: {
      id: 'event-rollout-window',
      status: 'accepted',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(),
      acceptedAt: new Date(),
      acceptedCount: 1,
      remoteShopValidated: true,
      shopResolutionSource: DidiOrderWebhookShopResolutionSource.local,
    },
    createUniqueConflict: true,
  });
  const result = await subject.value.receive(
    TOKEN,
    payload({ shopId: REMOTE_SHOP_ID }),
  );
  assert.equal(result.deduplicated, true);
  assert.ok(subject.requestUpdates.some(update =>
    update.shopResolutionSource === DidiOrderWebhookShopResolutionSource.remote
      && update.remoteShopValidated === true));
});

test('failed and stale processing events are reclaimable', async () => {
  for (const existing of [
    {
      id: 'event-f',
      status: 'failed' as const,
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(),
    },
    {
      id: 'event-s',
      status: 'processing' as const,
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(Date.now() - DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS - 1000),
    },
  ]) {
    const subject = receiver({ createUniqueConflict: true, existing });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/refresh')) {
        return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
      }
      if (url.includes('/get')) {
        return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
      }
      return new Response(JSON.stringify({ errno: 0 }));
    }) as typeof fetch;
    try {
      const result = await subject.value.receive(TOKEN, payload());
      assert.equal(result.accepted, true);
      assert.equal(result.deduplicated, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('reclaim refreshes price and profit metadata only before the first acceptance', async () => {
  const subject = receiver({
    createUniqueConflict: true,
    existing: {
      id: 'event-refresh-finance',
      status: 'failed',
      appShopId: APP_SHOP_ID,
      didiShopId: REMOTE_SHOP_ID,
      startedAt: new Date(),
      acceptedCount: 0,
      confirmationCalls: 0,
      profitMxn: new Prisma.Decimal('1'),
    },
    finance: {
      mode: DidiOrderWebhookProfitMode.fixed_mxn,
      value: '8.25',
      mxnPerUsdRate: '20',
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    await subject.value.receive(TOKEN, payload({
      priceJson: '{"order_price":"111","real_price":"100","real_pay_price":"90"}',
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const reclaim = subject.updates.find(update => 'orderPriceMinor' in update);
  assert.equal(reclaim?.orderPriceMinor, 111n);
  assert.equal(reclaim?.realPriceMinor, 100n);
  assert.equal(reclaim?.realPayPriceMinor, 90n);
  assert.equal(String(reclaim?.profitMxn), '8.25');
  assert.equal(String(reclaim?.profitUsd), '0.4125');
});

test('receiver refuses app mismatch and ambiguous shop resolution before remote calls', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    await assert.rejects(
      receiver().value.receive(TOKEN, payload({ appId: '5764607584567296000' })),
      BadRequestException,
    );
    await assert.rejects(
      receiver({ shops: [SHOP_ID, '33333333-3333-4333-8333-333333333333'] })
        .value.receive(TOKEN, payload()),
      BadRequestException,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test('non-orderNew deliveries are rejected before any request/event persistence and do not consume the order', async () => {
  const subject = receiver();
  for (const body of [
    payload({ type: 'orderUpdate' }),
    payload({ type: 'OrderNew' }),
    payload({ type: ' orderNew ' }),
    Buffer.from(`{"app_id":${APP_ID},"data":{"type":"orderNew","order_id":${ORDER_ID}}}`),
    Buffer.from(`{"app_id":${APP_ID},"note":"contains type orderNew text"}`),
    Buffer.from('{not-json'),
  ]) {
    await assert.rejects(subject.value.receive(TOKEN, body), BadRequestException);
  }
  assert.equal(subject.requestCreates.length, 0);
  assert.equal(subject.requestUpdates.length, 0);
  assert.equal(subject.eventCreates.length, 0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok' }));
  }) as typeof fetch;
  try {
    const accepted = await subject.value.receive(TOKEN, payload());
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.deduplicated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(subject.requestCreates.length, 1);
  assert.equal(subject.eventCreates.length, 1);
  assert.equal(subject.currentEvent()?.acceptedCount, 1);
});

test('malformed orderNew deliveries are audited without storing raw body or token', async () => {
  const subject = receiver();
  const malformedOrderNew = Buffer.from('{"type":"orderNew","app_id":"bad"}');
  await assert.rejects(subject.value.receive(TOKEN, malformedOrderNew), BadRequestException);
  assert.equal(subject.requestCreates.length, 1);
  assert.equal(subject.requestCreates[0]?.type, 'orderNew');
  const audit = subject.requestUpdates.at(-1);
  assert.equal(audit?.stage, 'validation');
  assert.equal(audit?.outcome, 'rejected');
  assert.equal(audit?.localHttpStatus, 400);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('rawBody'), false);
  assert.equal(serialized.includes('auth_token'), false);
});

test('remote failures are audited without credentials, URLs, or raw payloads', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { total: 0, shop_list: [] },
      }));
    }
    if (url.includes('/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh' } }));
    }
    if (url.includes('/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth' } }));
    }
    return new Response(JSON.stringify({
      errno: 10005,
      errmsg: 'failed https://example.test/?auth_token=secret-value',
    }));
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload()), BadGatewayException);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const audit = subject.updates.at(-1);
  assert.equal(audit?.status, 'failed');
  assert.equal(String(audit?.remoteErrmsg).includes('secret-value'), false);
  assert.equal(String(audit?.remoteErrmsg).includes('https://'), false);
  assert.equal(JSON.stringify(audit).includes(ORDER_ID), false);
  const requestAudit = subject.requestUpdates.at(-1);
  assert.equal(requestAudit?.stage, 'confirmation');
  assert.equal(requestAudit?.outcome, 'failed');
  assert.equal(requestAudit?.localHttpStatus, 502);
  assert.equal(String(requestAudit?.remoteErrmsg).includes('secret-value'), false);
  assert.equal(String(requestAudit?.remoteErrmsg).includes('https://'), false);
});

test('authentication failures record their exact safe stage without credentials', async () => {
  const subject = receiver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/v1/shop/shop/list')) {
      return new Response(JSON.stringify({ errno: 0, data: { total: 0, shop_list: [] } }));
    }
    throw new Error(`auth failed for app_secret=${SECRET} Bearer ${TOKEN}`);
  }) as typeof fetch;
  try {
    await assert.rejects(subject.value.receive(TOKEN, payload()), BadGatewayException);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const audit = subject.requestUpdates.at(-1);
  assert.equal(audit?.stage, 'authentication');
  assert.equal(audit?.outcome, 'failed');
  assert.equal(String(audit?.errorMessage).includes(SECRET), false);
  assert.equal(String(audit?.errorMessage).includes(TOKEN), false);
});

interface AdminApplicationState {
  id: string;
  appId: string;
  appName: string;
  country: Country;
  appSecret: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  didiBindingEnvironment: null;
  orderWebhookTokenEncrypted: string | null;
  orderWebhookTokenHash: string | null;
  orderWebhookCreatedAt: Date | null;
  orderWebhookRotatedAt: Date | null;
  orderWebhookDisabledAt: Date | null;
  orderWebhookProfitMode: DidiOrderWebhookProfitMode | null;
  orderWebhookProfitValue: Prisma.Decimal | null;
  orderWebhookNativeToMxn: Prisma.Decimal | null;
  orderWebhookMxnPerUsd: Prisma.Decimal | null;
}

function adminService() {
  const state: AdminApplicationState = {
    id: APPLICATION_ID,
    appId: APP_ID,
    appName: 'Test App',
    country: Country.MX,
    appSecret: encrypt(SECRET, KEY),
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    didiBindingEnvironment: null,
    orderWebhookTokenEncrypted: null,
    orderWebhookTokenHash: null,
    orderWebhookCreatedAt: null,
    orderWebhookRotatedAt: null,
    orderWebhookDisabledAt: null,
    orderWebhookProfitMode: null,
    orderWebhookProfitValue: null,
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: null,
  };
  const prisma = {
    application: {
      findUnique: async () => ({ ...state }),
      updateMany: async (input: { where: { orderWebhookTokenHash: null }; data: Partial<AdminApplicationState> }) => {
        if (state.deletedAt || state.orderWebhookTokenHash !== input.where.orderWebhookTokenHash) {
          return { count: 0 };
        }
        Object.assign(state, input.data);
        return { count: 1 };
      },
      update: async (input: { data: Partial<AdminApplicationState> }) => {
        Object.assign(state, input.data);
        return { ...state };
      },
      create: async () => ({ ...state }),
    },
    brand: { findFirst: async () => null },
    didiOrderWebhookEvent: { findFirst: async () => null },
    didiOrderWebhookForwardTarget: {
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
  };
  const config = {
    getOrThrow: () => KEY,
    get: (name: string, fallback: string) => name === 'FRONTEND_URL'
      ? 'https://workspace.example/guaro/'
      : fallback,
  };
  return {
    value: new ApplicationsService(prisma as never, config as never),
    state,
  };
}

test('concurrent generation returns one opaque encrypted URL and admin contract', async () => {
  const subject = adminService();
  const [first, second] = await Promise.all([
    subject.value.createOrderWebhook(APPLICATION_ID),
    subject.value.createOrderWebhook(APPLICATION_ID),
  ]);
  assert.equal(first.enabled, true);
  assert.equal(first.url, second.url);
  assert.match(first.url ?? '', /^https:\/\/workspace\.example\/guaro\/api\/didi-order-webhooks\/[A-Za-z0-9_-]{43}$/);
  assert.equal(first.lastReceivedAt, null);
  assert.equal(first.lastAcceptedAt, null);
  assert.equal(first.lastError, null);
  assert.notEqual(subject.state.orderWebhookTokenEncrypted, first.url?.split('/').at(-1));
  const clear = decrypt(subject.state.orderWebhookTokenEncrypted ?? '', KEY);
  assert.equal(
    createHash('sha256').update(clear).digest('hex'),
    subject.state.orderWebhookTokenHash,
  );
});

test('simultaneous rotations from the same URL converge on one winner', async () => {
  const subject = adminService();
  await subject.value.createOrderWebhook(APPLICATION_ID);
  const [first, second] = await Promise.all([
    subject.value.rotateOrderWebhook(APPLICATION_ID),
    subject.value.rotateOrderWebhook(APPLICATION_ID),
  ]);
  assert.equal(first.enabled, true);
  assert.equal(first.url, second.url);
  assert.equal(first.url?.split('/').at(-1), decrypt(subject.state.orderWebhookTokenEncrypted ?? '', KEY));
});

test('financial estimates require explicit values and can be disabled without defaults', async () => {
  const subject = adminService();
  await assert.rejects(
    subject.value.updateOrderWebhookFinance(APPLICATION_ID, {
      mode: DidiOrderWebhookProfitMode.fixed_mxn,
    }),
    BadRequestException,
  );

  const configured = await subject.value.updateOrderWebhookFinance(APPLICATION_ID, {
    mode: DidiOrderWebhookProfitMode.fixed_mxn,
    value: '8.5',
    mxnPerUsdRate: '17',
  });
  assert.deepEqual(configured.finance, {
    configured: true,
    mode: DidiOrderWebhookProfitMode.fixed_mxn,
    value: '8.5',
    nativeToMxnRate: null,
    mxnPerUsdRate: '17',
    nativeCurrency: 'MXN',
  });

  const disabled = await subject.value.updateOrderWebhookFinance(APPLICATION_ID, { mode: null });
  assert.equal(disabled.finance.configured, false);
  assert.equal(subject.state.orderWebhookProfitMode, null);
  assert.equal(subject.state.orderWebhookProfitValue, null);
  assert.equal(subject.state.orderWebhookMxnPerUsd, null);
});

test('percentage estimates for non-MXN applications require a native-to-MXN rate', async () => {
  const subject = adminService();
  subject.state.country = Country.CO;
  await assert.rejects(
    subject.value.updateOrderWebhookFinance(APPLICATION_ID, {
      mode: DidiOrderWebhookProfitMode.percentage,
      value: '5',
      mxnPerUsdRate: '20',
    }),
    /Native currency to MXN rate is required/,
  );

  const configured = await subject.value.updateOrderWebhookFinance(APPLICATION_ID, {
    mode: DidiOrderWebhookProfitMode.percentage,
    value: '5',
    nativeToMxnRate: '0.004',
    mxnPerUsdRate: '20',
  });
  assert.equal(configured.finance.nativeCurrency, 'COP');
  assert.equal(configured.finance.nativeToMxnRate, '0.004');
});

test('changing application country clears currency-specific webhook finance configuration', async () => {
  const subject = adminService();
  await subject.value.updateOrderWebhookFinance(APPLICATION_ID, {
    mode: DidiOrderWebhookProfitMode.percentage,
    value: '5',
    mxnPerUsdRate: '20',
  });

  await subject.value.update(APPLICATION_ID, { country: Country.CO });

  assert.equal(subject.state.country, Country.CO);
  assert.equal(subject.state.orderWebhookProfitMode, null);
  assert.equal(subject.state.orderWebhookProfitValue, null);
  assert.equal(subject.state.orderWebhookNativeToMxn, null);
  assert.equal(subject.state.orderWebhookMxnPerUsd, null);
});

test('disable, soft-delete, and restore cannot revive an old webhook URL', async () => {
  const subject = adminService();
  const generated = await subject.value.createOrderWebhook(APPLICATION_ID);
  const oldUrl = generated.url;
  const disabled = await subject.value.disableOrderWebhook(APPLICATION_ID);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.url, null);
  assert.equal(subject.state.orderWebhookTokenEncrypted, null);
  assert.equal(subject.state.orderWebhookTokenHash, null);

  await subject.value.createOrderWebhook(APPLICATION_ID);
  await subject.value.remove(APPLICATION_ID);
  assert.equal(subject.state.orderWebhookTokenEncrypted, null);
  assert.equal(subject.state.orderWebhookTokenHash, null);
  await subject.value.create({
    appId: APP_ID,
    appName: 'Restored App',
    appSecret: 'replacement-secret',
    country: Country.MX,
  }, '44444444-4444-4444-8444-444444444444');
  const restored = await subject.value.getOrderWebhook(APPLICATION_ID);
  assert.equal(restored.enabled, false);
  assert.equal(restored.url, null);
  assert.notEqual(restored.url, oldUrl);
});

test('global error logging redacts the bearer token from the route', () => {
  const url = `/didi-order-webhooks/${TOKEN}?source=didi`;
  const safe = redactSensitiveRequestUrl(url);
  assert.equal(safe, '/didi-order-webhooks/[redacted]?source=didi');
  assert.equal(safe.includes(TOKEN), false);
});
