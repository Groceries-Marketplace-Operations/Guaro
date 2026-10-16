import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountRole, Prisma } from '@prisma/client';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '../src/access-control/permissions.decorator';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { CentralDidiOrderWebhookEventsController } from '../src/didi-order-webhooks/central-didi-order-webhook-events.controller';
import { DidiOrderWebhookEventsController } from '../src/didi-order-webhooks/didi-order-webhook-events.controller';
import {
  DidiOrderWebhookEventsService,
  sanitizeDisplayText,
  unixTimestampToIso,
} from '../src/didi-order-webhooks/didi-order-webhook-events.service';
import { CentralOrderWebhookEventsQueryDto } from '../src/didi-order-webhooks/dto/central-order-webhook-events-query.dto';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-03T20:00:00.000Z');

function safeRequest() {
  return {
    id: REQUEST_ID,
    applicationId: APPLICATION_ID,
    eventId: EVENT_ID,
    appShopId: '83013',
    didiShopId: '5764607688097661019',
    orderId: '5764685048762665383',
    type: 'orderNew',
    stage: 'completed' as const,
    outcome: 'accepted' as const,
    shopResolutionSource: 'local' as const,
    profitRecognized: true,
    remoteShopValidated: false,
    localHttpStatus: 200,
    durationMs: 321,
    remoteHttpStatus: 200,
    remoteErrno: 0,
    remoteErrmsg: 'ok',
    errorMessage: null,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    application: {
      id: APPLICATION_ID,
      appId: '5764600000000000001',
      appName: 'Sally App',
      country: 'CO' as const,
    },
    event: {
      shopId: '44444444-4444-4444-8444-444444444444',
      didiShopId: '5764607688097661019',
      status: 'accepted' as const,
      attempts: 1,
      acceptedCount: 1,
      confirmationCalls: 2,
      shopResolutionSource: 'local' as const,
      remoteShopValidated: false,
      orderPriceMinor: 3_000n,
      realPriceMinor: 2_750n,
      realPayPriceMinor: 2_499n,
      orderCurrency: 'COP',
      profitMode: 'percentage' as const,
      profitValue: new Prisma.Decimal('5'),
      nativeToMxnRate: new Prisma.Decimal('0.004'),
      mxnPerUsdRate: new Prisma.Decimal('20'),
      profitMxn: new Prisma.Decimal('0.05'),
      profitUsd: new Prisma.Decimal('0.0025'),
      sourceTimestamp: '1770000000000000',
      startedAt: NOW,
      acceptedAt: NOW,
      failedAt: null,
      shop: {
        id: '44444444-4444-4444-8444-444444444444',
        shopId: 'internal-shop-id',
        name: 'Sally',
        brand: { id: 'brand-uuid', brandId: 'brand-id', brandName: 'Sally' },
      },
    },
  };
}

test('admin request log list is application-scoped, filtered, bounded, and secret-free', async () => {
  const findManyCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    application: {
      findFirst: async () => ({ id: APPLICATION_ID, appName: 'Sally App' }),
    },
    didiOrderWebhookRequest: {
      findMany: async (input: Record<string, unknown>) => {
        findManyCalls.push(input);
        return [safeRequest()];
      },
      groupBy: async () => [{ outcome: 'accepted', _count: { _all: 1 } }],
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  const result = await service.findAll(APPLICATION_ID, {
    page: 2,
    limit: 10,
    status: 'accepted',
    appShopId: '83013',
    orderId: '5764685048762665383',
    from: '2026-09-03T00:00:00.000Z',
    to: '2026-09-04T00:00:00.000Z',
  });

  const query = findManyCalls[0] as {
    where: Record<string, unknown>;
    skip: number;
    take: number;
    select: Record<string, unknown>;
  };
  assert.deepEqual(query.where, {
    applicationId: APPLICATION_ID,
    outcome: 'accepted',
    appShopId: '83013',
    orderId: '5764685048762665383',
    createdAt: {
      gte: new Date('2026-09-03T00:00:00.000Z'),
      lte: new Date('2026-09-04T00:00:00.000Z'),
    },
  });
  assert.equal(query.skip, 10);
  assert.equal(query.take, 10);
  assert.deepEqual(query.select.application, {
    select: { id: true, appId: true, appName: true, country: true },
  });
  assert.deepEqual(result.data[0].application, {
    id: APPLICATION_ID,
    appId: '5764600000000000001',
    appName: 'Sally App',
    country: 'CO',
  });
  assert.equal(result.data[0].sourceOccurredAt, '2026-02-02T02:40:00.000Z');
  assert.equal(result.data[0].shop?.name, 'Sally');
  assert.equal(result.data[0].didiShopId, '5764607688097661019');
  assert.equal(result.data[0].orderPrice, '30.00');
  assert.equal(result.data[0].realPrice, '27.50');
  assert.equal(result.data[0].realPayPrice, '24.99');
  assert.equal(result.data[0].profitMxn, '0.05');
  assert.equal(result.data[0].profitUsd, '0.0025');
  assert.equal(result.data[0].profitRecognized, true);
  assert.equal(result.data[0].confirmationCalls, 2);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'appSecret',
    'orderWebhookTokenHash',
    'orderWebhookTokenEncrypted',
    'rawBody',
    'authorization',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('central request log list spans applications without adding an application filter', async () => {
  let applicationLookups = 0;
  let findManyInput: Record<string, unknown> | undefined;
  const prisma = {
    application: {
      findFirst: async () => {
        applicationLookups += 1;
        return null;
      },
    },
    didiOrderWebhookRequest: {
      findMany: async (input: Record<string, unknown>) => {
        findManyInput = input;
        return [safeRequest()];
      },
      groupBy: async () => [{ outcome: 'accepted', _count: { _all: 1 } }],
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  const result = await service.findAllGlobal({ page: 1, limit: 25 });

  assert.equal(applicationLookups, 0);
  assert.deepEqual(findManyInput?.where, {});
  assert.equal(result.total, 1);
  assert.equal(result.summary.total, 1);
  assert.equal(result.data[0].application.appName, 'Sally App');
  assert.equal(JSON.stringify(result).includes('appSecret'), false);
});

test('central filters use exact indexed order/shop IDs, an App ID prefix, and recognize profit once', async () => {
  let findManyInput: Record<string, unknown> | undefined;
  const prisma = {
    didiOrderWebhookRequest: {
      findMany: async (input: Record<string, unknown>) => {
        findManyInput = input;
        return [];
      },
      groupBy: async () => [],
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  await service.findAllGlobal({
    page: 1,
    limit: 25,
    q: '5764685048762665383',
    didiShopId: '5764607688097661019',
    country: 'CO',
    stage: 'confirmation',
    amountField: 'order_price',
    minOrderAmount: '10.50',
    maxOrderAmount: '30.00',
    minProfitMxn: '1.25',
    maxProfitMxn: '9.50',
    hasProfit: true,
    minDurationMs: 100,
    maxDurationMs: 2_000,
  });

  const where = findManyInput?.where as Record<string, unknown>;
  assert.equal(where.didiShopId, '5764607688097661019');
  assert.equal(where.stage, 'confirmation');
  assert.equal(where.profitRecognized, true);
  assert.deepEqual(where.application, { country: 'CO' });
  assert.deepEqual(where.durationMs, { gte: 100, lte: 2_000 });
  assert.deepEqual(where.OR, [
    { orderId: '5764685048762665383' },
    { appShopId: '5764685048762665383' },
    { didiShopId: '5764685048762665383' },
    { application: { appId: { startsWith: '5764685048762665383' } } },
  ]);
  const event = (where.event as { is: Record<string, unknown> }).is;
  assert.deepEqual(event.orderPriceMinor, { gte: 1_050n, lte: 3_000n });
  const profit = event.profitMxn as { gte: Prisma.Decimal; lte: Prisma.Decimal; not: null };
  assert.equal(profit.gte.toString(), '1.25');
  assert.equal(profit.lte.toString(), '9.5');
  assert.equal(profit.not, null);
});

test('profit ranges cannot include unrecognized duplicate or failed requests', async () => {
  let queries = 0;
  const prisma = {
    didiOrderWebhookRequest: {
      findMany: async () => {
        queries += 1;
        return [];
      },
      groupBy: async () => [],
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);

  await assert.rejects(
    service.findAllGlobal({
      page: 1,
      limit: 25,
      hasProfit: false,
      minProfitMxn: '1.00',
    }),
    (error: unknown) => error instanceof BadRequestException
      && error.message.includes('Profit ranges require hasProfit=true'),
  );
  assert.equal(queries, 0);
});

test('central request log list optionally scopes every query by applicationId', async () => {
  const findManyCalls: Array<Record<string, unknown>> = [];
  const groupByCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    application: {
      findFirst: async (input: Record<string, unknown>) => {
        assert.deepEqual(input, {
          where: { id: APPLICATION_ID, deletedAt: null },
          select: { id: true, appName: true },
        });
        return { id: APPLICATION_ID, appName: 'Sally App' };
      },
    },
    didiOrderWebhookRequest: {
      findMany: async (input: Record<string, unknown>) => {
        findManyCalls.push(input);
        return [safeRequest()];
      },
      groupBy: async (input: Record<string, unknown>) => {
        groupByCalls.push(input);
        return [{ outcome: 'failed', _count: { _all: 1 } }];
      },
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  const result = await service.findAllGlobal({
    applicationId: APPLICATION_ID,
    status: 'failed',
    page: 1,
    limit: 25,
  });

  assert.deepEqual(findManyCalls[0].where, {
    applicationId: APPLICATION_ID,
    outcome: 'failed',
  });
  assert.equal(groupByCalls.length, 1);
  assert.deepEqual(groupByCalls[0], {
    by: ['outcome'],
    where: { applicationId: APPLICATION_ID },
    _count: { _all: true },
  });
  assert.equal(result.total, 1);
  assert.equal(result.summary.failed, 1);
});

test('central request log detail resolves by request id and returns safe application identity', async () => {
  let where: unknown;
  let select: unknown;
  const prisma = {
    didiOrderWebhookRequest: {
      findFirst: async (input: { where: unknown; select: unknown }) => {
        where = input.where;
        select = input.select;
        return safeRequest();
      },
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  const result = await service.findOneGlobal(REQUEST_ID);

  assert.deepEqual(where, { id: REQUEST_ID });
  assert.deepEqual((select as { application: unknown }).application, {
    select: { id: true, appId: true, appName: true, country: true },
  });
  assert.deepEqual(result.application, safeRequest().application);
  assert.equal(JSON.stringify(result).includes('appSecret'), false);
});

test('central request log query accepts an optional UUID applicationId and rejects invalid values', async () => {
  const valid = Object.assign(new CentralOrderWebhookEventsQueryDto(), {
    applicationId: APPLICATION_ID,
  });
  assert.deepEqual(await validate(valid), []);

  const invalid = Object.assign(new CentralOrderWebhookEventsQueryDto(), {
    applicationId: 'not-an-application-uuid',
  });
  const errors = await validate(invalid);
  assert.ok(errors.some(error => error.property === 'applicationId'));

  const shortSearch = Object.assign(new CentralOrderWebhookEventsQueryDto(), { q: 'ab' });
  const searchErrors = await validate(shortSearch);
  assert.ok(searchErrors.some(error => error.property === 'q'));
});

test('request log serializes a remotely validated event without a local Shop', async () => {
  const request = safeRequest();
  request.event.shopId = null as never;
  request.event.shop = null as never;
  request.event.remoteShopValidated = true;
  request.remoteShopValidated = true;
  request.shopResolutionSource = null as never;
  request.event.shopResolutionSource = 'local';
  const prisma = {
    application: {
      findFirst: async () => ({ id: APPLICATION_ID, appName: 'CKA App' }),
    },
    didiOrderWebhookRequest: {
      findFirst: async () => request,
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  const result = await service.findOne(APPLICATION_ID, REQUEST_ID);
  assert.equal(result.shop, null);
  assert.equal(result.shopId, null);
  assert.equal(result.didiShopId, '5764607688097661019');
  assert.equal(result.remoteShopValidated, true);
  assert.equal(result.shopResolutionSource, 'remote');
});

test('detail cannot cross application scope', async () => {
  let where: unknown;
  const prisma = {
    application: {
      findFirst: async () => ({ id: APPLICATION_ID, appName: 'Sally App' }),
    },
    didiOrderWebhookRequest: {
      findFirst: async (input: { where: unknown }) => {
        where = input.where;
        return null;
      },
    },
  };
  const service = new DidiOrderWebhookEventsService(prisma as never);
  await assert.rejects(service.findOne(APPLICATION_ID, REQUEST_ID), NotFoundException);
  assert.deepEqual(where, { id: REQUEST_ID, applicationId: APPLICATION_ID });
});

test('timestamp conversion keeps bigint precision and display sanitizer strips credentials', () => {
  assert.equal(unixTimestampToIso('1770000000'), '2026-02-02T02:40:00.000Z');
  assert.equal(unixTimestampToIso('1770000000000'), '2026-02-02T02:40:00.000Z');
  assert.equal(unixTimestampToIso('1770000000000000'), '2026-02-02T02:40:00.000Z');
  const opaque = 'A'.repeat(43);
  const sanitized = sanitizeDisplayText(
    `Authorization: Bearer ${opaque} app_secret=visible https://example.test/${opaque}`,
  );
  assert.equal(sanitized?.includes(opaque), false);
  assert.equal(sanitized?.includes('visible'), false);
  assert.equal(sanitized?.includes('https://'), false);
});

test('request log controllers declare their required roles and permissions', () => {
  assert.deepEqual(
    Reflect.getMetadata(ROLES_KEY, DidiOrderWebhookEventsController),
    [AccountRole.admin, AccountRole.super_admin],
  );
  assert.deepEqual(
    Reflect.getMetadata(ROLES_KEY, CentralDidiOrderWebhookEventsController),
    [AccountRole.admin, AccountRole.super_admin],
  );
  assert.deepEqual(
    Reflect.getMetadata(PERMISSIONS_KEY, CentralDidiOrderWebhookEventsController),
    ['applications.update'],
  );
});

test('request-log migration backfills legacy events without payload or credential columns', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260903030000_didi_order_webhook_request_logs/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /FROM "didi_order_webhook_event" event/);
  assert.match(sql, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(sql, /'legacy'::"DidiOrderWebhookRequestStage"/);
  assert.doesNotMatch(sql, /"raw_body"|"headers"|"webhook_token"|"auth_token"|"app_secret"/);
});

test('central request-log indexes are additive and contain no sensitive columns', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260904020000_didi_order_webhook_global_log_indexes/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /\("created_at", "id"\)/);
  assert.match(sql, /\("outcome", "created_at"\)/);
  assert.doesNotMatch(sql, /DROP|DELETE|TRUNCATE|raw_body|headers|auth_token|app_secret/i);
});

test('high-volume webhook filter migration has a verified local fallback without concurrent DDL', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261015005000_didi_order_webhook_filter_indexes/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /CREATE INDEX IF NOT EXISTS[\s\S]+\("order_id", "application_id"\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS[\s\S]+\("app_shop_id", "application_id"\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS[\s\S]+\("didi_shop_id", "application_id"\)/);
  assert.match(sql, /pg_class[\s\S]+pg_index[\s\S]+indisvalid[\s\S]+indisready/);
  assert.doesNotMatch(
    sql,
    /CREATE\s+INDEX\s+CONCURRENTLY|pg_trgm|raw_body|headers|auth_token|app_secret/i,
  );
});

test('financial migration stores three optional amounts and one-time profit recognition without payload PII', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261016020000_didi_order_webhook_financials/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /"order_price_minor" BIGINT/);
  assert.match(sql, /"real_price_minor" BIGINT/);
  assert.match(sql, /"real_pay_price_minor" BIGINT/);
  assert.match(sql, /"profit_recognized" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /didi_order_webhook_event_prices_check[\s\S]+NOT VALID/);
  assert.match(sql, /didi_order_webhook_event_profit_snapshot_check[\s\S]+NOT VALID/);
  assert.match(sql, /WHEN duplicate_object THEN NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "order_price_minor" BIGINT/);
  assert.match(sql, /pg_constraint[\s\S]+application_order_webhook_profit_config_check/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.doesNotMatch(sql, /raw_body|headers|customer|address|phone|auth_token|app_secret/i);
});

test('financial index migration has sparse verified local fallbacks without concurrent DDL', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261016021000_didi_order_webhook_financial_indexes/migration.sql',
    ),
    'utf8',
  );
  for (const column of [
    'order_price_minor',
    'real_price_minor',
    'real_pay_price_minor',
    'profit_mxn',
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS[\\s\\S]+WHERE "${column}" IS NOT NULL`));
  }
  assert.match(sql, /WHERE "profit_recognized" = true/);
  assert.match(sql, /pg_class[\s\S]+pg_index[\s\S]+indpred IS NOT NULL/);
  assert.doesNotMatch(
    sql,
    /CREATE\s+INDEX\s+CONCURRENTLY|pg_trgm|raw_body|headers|auth_token|app_secret/i,
  );
});

test('production builds all webhook filter indexes online through psql autocommit', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../prisma/deploy/didi_order_webhook_indexes_online.sql'),
    'utf8',
  );
  assert.equal((sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) ?? []).length, 8);
  assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS/);
  assert.match(sql, /NOT index_state\.indisvalid[\s\S]+NOT index_state\.indisready/);
  assert.match(sql, /pg_attribute[\s\S]+expected\.indexed_columns/);
  assert.match(sql, /\("order_id", "application_id"\)/);
  assert.match(sql, /\("app_shop_id", "application_id"\)/);
  assert.match(sql, /\("didi_shop_id", "application_id"\)/);
  for (const column of [
    'order_price_minor',
    'real_price_minor',
    'real_pay_price_minor',
    'profit_mxn',
  ]) {
    assert.match(sql, new RegExp(`WHERE "${column}" IS NOT NULL`));
  }
  assert.match(sql, /WHERE "profit_recognized" = true/);
  assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b|raw_body|headers|auth_token|app_secret/i);
});

test('production deploy expands schema, creates online indexes, then records Prisma migrations', () => {
  const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8');
  const expansion = workflow.indexOf(
    'prisma/migrations/20261016020000_didi_order_webhook_financials/migration.sql',
  );
  const onlineIndexes = workflow.indexOf('prisma/deploy/didi_order_webhook_indexes_online.sql');
  const migrateDeploy = workflow.indexOf('npx prisma migrate deploy --schema=./prisma/schema.prisma');

  assert.ok(expansion >= 0);
  assert.ok(onlineIndexes > expansion);
  assert.ok(migrateDeploy > onlineIndexes);
  assert.match(workflow, /psql -X -v ON_ERROR_STOP=1/);
  assert.match(
    workflow,
    /migrate resolve --rolled-back 20261015005000_didi_order_webhook_filter_indexes/,
  );
});

test('confirmation-budget migration adds a bounded budget without rewriting legacy rows', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261016022000_didi_order_webhook_confirmation_budget/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /ADD COLUMN "confirmation_calls" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /CHECK \("confirmation_calls" >= 0 AND "confirmation_calls" <= 2\) NOT VALID/);
  assert.doesNotMatch(sql, /UPDATE|DROP|DELETE|TRUNCATE|raw_body|headers|auth_token|app_secret/i);
});

test('unmapped-shop migration backfills DiDi shop IDs and makes only the local FK nullable', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260904010000_didi_order_webhook_unmapped_shops/migration.sql',
    ),
    'utf8',
  );
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /SET "didi_shop_id" = shop\."shop_id"/);
  assert.match(sql, /ALTER COLUMN "shop_id" DROP NOT NULL/);
  assert.match(
    sql,
    /"shop_id" IS NOT NULL\s+OR \("didi_shop_id" IS NOT NULL AND "remote_shop_validated" = true\)/,
  );
  assert.doesNotMatch(sql, /ALTER COLUMN "didi_shop_id" SET NOT NULL/);
  assert.doesNotMatch(sql, /DROP CONSTRAINT|DROP TABLE|CASCADE/);
});
