import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { DidiOrderWebhookEventsController } from '../src/didi-order-webhooks/didi-order-webhook-events.controller';
import {
  DidiOrderWebhookEventsService,
  sanitizeDisplayText,
  unixTimestampToIso,
} from '../src/didi-order-webhooks/didi-order-webhook-events.service';

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
    event: {
      shopId: '44444444-4444-4444-8444-444444444444',
      didiShopId: '5764607688097661019',
      status: 'accepted' as const,
      attempts: 1,
      remoteShopValidated: false,
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
      count: async (input: { where?: { outcome?: string } }) =>
        input.where?.outcome === 'accepted' ? 1 : 0,
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
  assert.equal('application' in query.select, false);
  assert.equal(result.data[0].sourceOccurredAt, '2026-02-02T02:40:00.000Z');
  assert.equal(result.data[0].shop?.name, 'Sally');
  assert.equal(result.data[0].didiShopId, '5764607688097661019');
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

test('request log serializes a remotely validated event without a local Shop', async () => {
  const request = safeRequest();
  request.event.shopId = null as never;
  request.event.shop = null as never;
  request.event.remoteShopValidated = true;
  request.remoteShopValidated = true;
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

test('request log controller is limited to admin roles', () => {
  assert.deepEqual(
    Reflect.getMetadata(ROLES_KEY, DidiOrderWebhookEventsController),
    [AccountRole.admin, AccountRole.super_admin],
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
