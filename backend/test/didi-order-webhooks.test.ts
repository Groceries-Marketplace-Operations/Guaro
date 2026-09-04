import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  BadGatewayException,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Country } from '@prisma/client';
import { ApplicationsService } from '../src/applications/applications.service';
import { decrypt, encrypt } from '../src/common/crypto.util';
import { redactSensitiveRequestUrl } from '../src/common/filters/global-error.filter';
import {
  buildDidiOrderConfirmBody,
  DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES,
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
  return Buffer.from(
    `{"app_id":${appId}${rootShopField},`
      + `"timestamp":1770000000000,"type":${JSON.stringify(options.type ?? 'orderNew')},`
      + `"data":{"order_id":${orderId},"order_info":{"order_id":${nestedOrderId},`
      + `"shop":{${nestedShopFields}}}}}`,
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

interface ExistingEvent {
  id: string;
  status: 'processing' | 'accepted' | 'failed';
  appShopId: string;
  startedAt: Date;
}

function receiver(options: {
  shops?: string[];
  shopResponses?: string[][];
  existing?: ExistingEvent;
  createUniqueConflict?: boolean;
} = {}) {
  let existing = options.existing;
  const updates: Array<Record<string, unknown>> = [];
  const requestUpdates: Array<Record<string, unknown>> = [];
  const applicationFindCalls: unknown[] = [];
  const shopFindCalls: unknown[] = [];
  let shopFindIndex = 0;
  const prisma = {
    application: {
      findFirst: async (input: unknown) => {
        applicationFindCalls.push(input);
        return {
          id: APPLICATION_ID,
          appId: APP_ID,
          appSecret: encrypt(SECRET, KEY),
        };
      },
    },
    shop: {
      findMany: async (input: unknown) => {
        shopFindCalls.push(input);
        const ids = options.shopResponses?.[shopFindIndex++] ?? options.shops ?? [SHOP_ID];
        return ids.map(id => ({ id }));
      },
    },
    didiOrderWebhookRequest: {
      create: async () => ({ id: 'request-1' }),
      update: async (input: { data: Record<string, unknown> }) => {
        requestUpdates.push(input.data);
        return { id: 'request-1', ...input.data };
      },
    },
    didiOrderWebhookEvent: {
      create: async () => {
        if (options.createUniqueConflict || existing) throw { code: 'P2002' };
        existing = {
          id: 'event-1',
          status: 'processing',
          appShopId: APP_SHOP_ID,
          startedAt: new Date(),
        };
        return { id: existing.id, status: existing.status, appShopId: existing.appShopId };
      },
      findUnique: async () => existing ? { ...existing } : null,
      updateMany: async (input: { where: { status: string; startedAt?: { lt: Date } } }) => {
        if (!existing || existing.status !== input.where.status) return { count: 0 };
        if (input.where.startedAt && existing.startedAt >= input.where.startedAt.lt) return { count: 0 };
        existing = { ...existing, status: 'processing', startedAt: new Date() };
        return { count: 1 };
      },
      update: async (input: { data: Record<string, unknown> }) => {
        updates.push(input.data);
        if (existing && typeof input.data.status === 'string') {
          existing = { ...existing, status: input.data.status as ExistingEvent['status'] };
        }
        return existing;
      },
    },
  };
  const config = { getOrThrow: () => KEY };
  return {
    value: new DidiOrderWebhooksService(prisma as never, config as never),
    updates,
    requestUpdates,
    applicationFindCalls,
    shopFindCalls,
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
});

test('receiver resolves a missing app_shop_id from the application shop list', async () => {
  const subject = receiver();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/shop/shop/list')) {
      assert.deepEqual(subject.requestUpdates.at(-1), {
        stage: 'shop_resolution',
        appShopId: null,
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
      deletedAt: null,
      brand: { applicationId: APPLICATION_ID, deletedAt: null },
    },
    select: { id: true },
    take: 2,
  });
  const resolutionAudit = subject.requestUpdates.find(update => update.appShopId === APP_SHOP_ID);
  assert.equal(resolutionAudit?.appShopId, APP_SHOP_ID);
});

test('receiver verifies a supplied app_shop_id remotely when its exact local pair is missing', async () => {
  const subject = receiver({ shopResponses: [[], [SHOP_ID]] });
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
  assert.equal(calls.filter(url => url.endsWith('/v1/shop/shop/list')).length, 1);
  assert.equal(subject.shopFindCalls.length, 2);
  assert.deepEqual(subject.shopFindCalls[1], {
    where: {
      shopId: REMOTE_SHOP_ID,
      deletedAt: null,
      brand: { applicationId: APPLICATION_ID, deletedAt: null },
    },
    select: { id: true },
    take: 2,
  });
});

test('receiver rejects a supplied app_shop_id that disagrees with the remote shop mapping', async () => {
  const subject = receiver({ shopResponses: [[]] });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      errno: 0,
      data: {
        total: 1,
        shop_list: [{ shop_id: REMOTE_SHOP_ID, app_shop_id: 'remote-value' }],
      },
    }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      subject.value.receive(TOKEN, payload({ shopId: REMOTE_SHOP_ID })),
      /Payload app_shop_id does not match/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 1);
  assert.equal(subject.shopFindCalls.length, 1);
  assert.equal(subject.requestUpdates.at(-1)?.outcome, 'rejected');
});

test('missing app_shop_id fails closed when the remote shop is absent or ambiguous', async () => {
  for (const shopList of [
    [],
    [
      { shop_id: REMOTE_SHOP_ID, app_shop_id: APP_SHOP_ID },
      { shop_id: REMOTE_SHOP_ID, app_shop_id: 'different-app-shop' },
    ],
  ]) {
    const subject = receiver();
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
    assert.equal(subject.shopFindCalls.length, 0);
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

test('an accepted duplicate and a live processing duplicate never resend', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    const accepted = receiver({
      createUniqueConflict: true,
      existing: { id: 'event-a', status: 'accepted', appShopId: APP_SHOP_ID, startedAt: new Date() },
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
      existing: { id: 'event-p', status: 'processing', appShopId: APP_SHOP_ID, startedAt: new Date() },
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

test('failed and stale processing events are reclaimable', async () => {
  for (const existing of [
    { id: 'event-f', status: 'failed' as const, appShopId: APP_SHOP_ID, startedAt: new Date() },
    {
      id: 'event-s',
      status: 'processing' as const,
      appShopId: APP_SHOP_ID,
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

test('valid-token validation failures are audited, while no body or token is persisted', async () => {
  const subject = receiver();
  await assert.rejects(
    subject.value.receive(TOKEN, payload({ type: 'orderUpdate' })),
    BadRequestException,
  );
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
  globalThis.fetch = (async () => {
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
