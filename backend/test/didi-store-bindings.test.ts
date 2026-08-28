import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { encrypt } from '../src/common/crypto.util';
import { DidiStoreBindingsAdminGuard } from '../src/file-integrations/didi-store-bindings-admin.guard';
import { DidiStoreBindingsService } from '../src/file-integrations/didi-store-bindings.service';
import { BindDidiStoresDto, UnbindDidiStoresDto } from '../src/file-integrations/dto/didi-store-binding.dto';
import {
  buildBindRequest,
  DIDI_BIND_STORE_PATH,
  DIDI_LIST_BOUND_STORES_PATH,
  DIDI_UNBIND_STORE_PATH,
  isExplicitBindResponse,
  normalizeBindResults,
  redactDidiValue,
  stringifyDidiJsonWithInt64,
} from '../src/file-integrations/didi-store-bindings.util';

const APP_ID = '5764607654490537999';
const SECRET = 'test-secret-never-real-000000000000';
const KEY = '11'.repeat(32);
const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const SHOP_1 = '5764607654490537001';
const SHOP_2 = '5764607654490537002';
const SHOP_3 = '5764607654490537003';

test('admin guard requires an admin role in addition to route permissions', () => {
  const guard = new DidiStoreBindingsAdminGuard();
  const context = (roles: AccountRole[]) => ({
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  });

  assert.equal(guard.canActivate(context([AccountRole.admin]) as never), true);
  assert.equal(guard.canActivate(context([AccountRole.super_admin]) as never), true);
  assert.equal(guard.canActivate(context([AccountRole.user]) as never), false);
  assert.equal(guard.canActivate(context([]) as never), false);
});

function service(options: { appName?: string; appId?: string; allowlistedAppIds?: string; auditUpdateError?: Error } = {}) {
  const auditUpdates: unknown[] = [];
  const prisma = {
    application: {
      findFirst: async () => ({
        id: APPLICATION_ID,
        appId: options.appId ?? APP_ID,
        appName: options.appName ?? 'MX_T_CircleK',
        country: 'MX',
        appSecret: encrypt(SECRET, KEY),
      }),
    },
    accessControlAudit: {
      create: async () => ({ id: 'audit-1' }),
      update: async (input: unknown) => {
        auditUpdates.push(input);
        if (options.auditUpdateError) throw options.auditUpdateError;
        return input;
      },
    },
  };
  const config = {
    getOrThrow: (key: string) => {
      assert.equal(key, 'APP_SECRET_ENCRYPTION_KEY');
      return KEY;
    },
    get: (key: string, defaultValue: string) => key === 'DIDI_STORE_BINDINGS_TEST_APP_IDS'
      ? (options.allowlistedAppIds ?? APP_ID)
      : defaultValue,
  };
  return {
    value: new DidiStoreBindingsService(prisma as never, config as never),
    auditUpdates,
  };
}

test('bind request signs shop_infos as the literal Array and emits exact raw int64 IDs', () => {
  const request = buildBindRequest(APP_ID, SECRET, [
    { shopId: SHOP_1, appShopId: '001' },
    { shopId: SHOP_2, appShopId: 'store-2' },
  ], '1700000000');
  const expectedSign = createHash('md5')
    .update(`app_id=${APP_ID}&shop_infos=Array&timestamp=1700000000${SECRET}`)
    .digest('hex');

  assert.deepEqual(request.signatureParams, {
    app_id: APP_ID,
    shop_infos: 'Array',
    timestamp: '1700000000',
  });
  assert.equal(request.payload.sign, expectedSign);
  assert.match(request.body, new RegExp(`"app_id":${APP_ID}`));
  assert.match(request.body, new RegExp(`"shop_id":${SHOP_1}`));
  assert.match(request.body, /"app_shop_id":"001"/);
  assert.doesNotMatch(request.body, new RegExp(`"${APP_ID}"`));
});

test('int64 serializer rejects unsafe numeric input', () => {
  assert.throws(
    () => stringifyDidiJsonWithInt64({ shop_id: Number(SHOP_1) }),
    /decimal string.*int64 precision/,
  );
});

test('DTOs enforce exact shop IDs, required unbind mappings and operation-specific limits', async () => {
  const tooMany = plainToInstance(BindDidiStoresDto, {
    applicationId: APPLICATION_ID,
    shops: Array.from({ length: 51 }, (_, index) => ({
      shopId: `57${String(index).padStart(17, '0')}`,
      appShopId: `shop-${index}`,
    })),
    confirmation: 'VINCULAR 51 TIENDAS',
  });
  const missingUnbindShopId = plainToInstance(UnbindDidiStoresDto, {
    applicationId: APPLICATION_ID,
    shops: [{ appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  });
  const tooManyUnbind = plainToInstance(UnbindDidiStoresDto, {
    applicationId: APPLICATION_ID,
    shops: [
      { shopId: SHOP_1, appShopId: '001' },
      { shopId: SHOP_2, appShopId: '002' },
    ],
    confirmation: 'DESVINCULAR 2 TIENDAS',
  });

  assert.ok((await validate(tooMany)).some(error => error.property === 'shops'));
  assert.ok((await validate(missingUnbindShopId)).some(error => error.property === 'shops'));
  assert.ok((await validate(tooManyUnbind)).some(error => error.property === 'shops'));
});

test('bind normalization keeps partial results and never returns auth tokens', () => {
  const token = 'provider-secret-auth-token';
  const results = normalizeBindResults([
    { shopId: SHOP_1, appShopId: '001' },
    { shopId: SHOP_2, appShopId: '002' },
  ], {
    failure_list: [{ shop_id: SHOP_2, app_shop_id: '002', reason: `auth_token=${token}` }],
    success_list: [{ shop_id: SHOP_1, app_shop_id: '001', auth_token: token }],
  });
  assert.deepEqual(results[0], { shopId: SHOP_1, appShopId: '001', status: 'success' });
  assert.equal(results[1].status, 'failed');
  assert.doesNotMatch(JSON.stringify(results), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(redactDidiValue({ auth_token: token })), new RegExp(token));
});

test('bind normalization treats an omitted per-store decision as unconfirmed', () => {
  const results = normalizeBindResults([
    { shopId: SHOP_1, appShopId: '001' },
    { shopId: SHOP_2, appShopId: '002' },
  ], {
    success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
    failure_list: [],
  });

  assert.equal(results[0].status, 'success');
  assert.equal(results[1].status, 'unconfirmed');
  assert.match(results[1].reason ?? '', /Verifica estado antes de reintentar\./);
});

test('bind requires a strict explicit provider response', () => {
  assert.equal(isExplicitBindResponse({ errno: 'not-a-number', errmsg: 'bad response' }), false);
  assert.equal(isExplicitBindResponse({ errno: '10002', errmsg: 'provider rejected' }), true);
  assert.equal(isExplicitBindResponse({ success_list: [], failure_list: [] }), true);
  assert.equal(isExplicitBindResponse({ success_list: [] }), false);
});

test('bind treats contradictory per-store provider decisions as unconfirmed', () => {
  const results = normalizeBindResults([{ shopId: SHOP_1, appShopId: '001' }], {
    success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
    failure_list: [{ shop_id: SHOP_1, app_shop_id: '001', reason: 'rejected' }],
  });

  assert.equal(results[0].status, 'unconfirmed');
  assert.match(results[0].reason ?? '', /conflicting results/);
});

test('bind service performs exactly one provider bind request and returns audited partial results', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests: Array<{ url: string; body: string }> = [];
  const token = 'must-never-leak';
  global.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({
      success_list: [{ shop_id: SHOP_1, app_shop_id: '001', auth_token: token }],
      failure_list: [{ shop_id: SHOP_2, app_shop_id: '002', reason: 'already bound' }],
    }), { status: 200 });
  }) as typeof fetch;
  const created = service();

  const response = await created.value.bind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }, { shopId: SHOP_2, appShopId: '002' }],
    confirmation: 'VINCULAR 2 TIENDAS',
  }, ACTOR_ID);

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, new RegExp(`${DIDI_BIND_STORE_PATH}$`));
  assert.match(requests[0].body, new RegExp(`"shop_id":${SHOP_1}`));
  assert.deepEqual(response.summary, {
    total: 2,
    succeeded: 1,
    failed: 1,
    unconfirmed: 0,
    skipped: 0,
    status: 'partial',
  });
  assert.equal(response.results[0].success, true);
  assert.equal(response.results[1].message, 'already bound');
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(created.auditUpdates), new RegExp(token));
});

test('duplicates and a non-test application are rejected before any provider request', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;

  await assert.rejects(
    () => service().value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: 'same' }, { shopId: SHOP_2, appShopId: 'same' }],
      confirmation: 'VINCULAR 2 TIENDAS',
    }, ACTOR_ID),
    /Duplicate appShopId/,
  );
  await assert.rejects(
    () => service().value.unbind({
      applicationId: APPLICATION_ID,
      shops: [
        { shopId: SHOP_1, appShopId: '001' },
        { shopId: SHOP_2, appShopId: '002' },
      ],
      confirmation: 'DESVINCULAR 2 TIENDAS',
    }, ACTOR_ID),
    /At most 1 store is allowed/,
  );
  await assert.rejects(
    () => service({ appName: 'MX_T_CircleK', appId: '5764607654490537998' }).value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID),
    (error: Error) => error instanceof BadRequestException && /not in DIDI_STORE_BINDINGS_TEST_APP_IDS/.test(error.message),
  );
  await assert.rejects(
    () => service({ appName: 'MX_T_CircleK', appId: '5764607654490537998' }).value.listBoundStores({
      applicationId: APPLICATION_ID,
      pageNo: 1,
      pageSize: 100,
    }),
    /not in DIDI_STORE_BINDINGS_TEST_APP_IDS/,
  );
  assert.equal(calls, 0);
});

test('bind and unbind share an application lock and always release it', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let notifyStarted!: () => void;
  let releaseFetch!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
  global.fetch = (async () => {
    notifyStarted();
    await gate;
    return new Response(JSON.stringify({
      success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
      failure_list: [],
    }), { status: 200 });
  }) as typeof fetch;
  const created = service();
  const dto = {
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'VINCULAR 1 TIENDAS',
  };

  const first = created.value.bind(dto, ACTOR_ID);
  await started;
  await assert.rejects(
    () => created.value.bind(dto, ACTOR_ID),
    /already running for this application/,
  );
  releaseFetch();
  await first;
  const third = await created.value.bind(dto, ACTOR_ID);
  assert.equal(third.summary.succeeded, 1);
});

test('unbind verifies the exact remote mapping before auth and redacts provider token errors', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls: string[] = [];
  const token = 'unbind-auth-token-secret';
  global.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 1,
          page_size: 100,
          total_page: 1,
          total_cnt: 2,
          shops: [
            { shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 },
            { shop_id: SHOP_2, app_shop_id: '002', bound_flag: 1 },
          ],
        },
      }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-secret' } }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: token } }), { status: 200 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) {
      return new Response(JSON.stringify({ errno: 10002, errmsg: `auth_token=${token}`, data: false }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const created = service();

  const response = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  }, ACTOR_ID);

  assert.match(calls[0], new RegExp(`${DIDI_LIST_BOUND_STORES_PATH}$`));
  assert.equal(calls.filter(url => url.includes('/authtoken/refresh')).length, 1);
  assert.equal(calls.filter(url => url.endsWith(DIDI_UNBIND_STORE_PATH)).length, 1);
  assert.deepEqual(response.summary, {
    total: 1,
    succeeded: 0,
    failed: 1,
    unconfirmed: 0,
    skipped: 0,
    status: 'failed',
  });
  assert.match(response.results[0].message ?? '', /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(created.auditUpdates), new RegExp(token));
});

test('single-store unbind rejects a mismatched remote mapping before requesting auth', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls: string[] = [];
  global.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 1,
          page_size: 100,
          total_page: 1,
          total_cnt: 1,
          shops: [{ shop_id: SHOP_2, app_shop_id: '002', bound_flag: 1 }],
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const response = await service().value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_3, appShopId: '002' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  }, ACTOR_ID);

  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`${DIDI_LIST_BOUND_STORES_PATH}$`));
  assert.equal(response.summary.failed, 1);
  assert.match(response.results[0].message ?? '', /Mapping mismatch/);
});

test('bind marks every store unconfirmed when the POST has no valid provider response', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const token = 'transport-auth-token-secret';
  global.fetch = (async (input) => {
    if (String(input).endsWith(DIDI_BIND_STORE_PATH)) {
      throw new Error(`socket closed auth_token=${token}`);
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  }) as typeof fetch;
  const created = service();

  const response = await created.value.bind({
    applicationId: APPLICATION_ID,
    shops: [
      { shopId: SHOP_1, appShopId: '001' },
      { shopId: SHOP_2, appShopId: '002' },
    ],
    confirmation: 'VINCULAR 2 TIENDAS',
  }, ACTOR_ID);

  assert.deepEqual(response.summary, {
    total: 2,
    succeeded: 0,
    failed: 0,
    unconfirmed: 2,
    skipped: 0,
    status: 'unconfirmed',
  });
  assert.ok(response.results.every(result => result.status === 'unconfirmed'));
  assert.ok(response.results.every(result => !Object.prototype.hasOwnProperty.call(result, 'success')));
  assert.ok(response.results.every(result => /Verifica estado antes de reintentar\./.test(result.message ?? '')));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(created.auditUpdates), new RegExp(token));
});

test('unbind distinguishes POST uncertainty from explicit provider failure', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const token = 'unbind-transport-secret';
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 1,
          page_size: 100,
          total_page: 1,
          total_cnt: 1,
          shops: [{ shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 }],
        },
      }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-secret' } }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: token } }), { status: 200 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) {
      throw new Error(`connection reset auth_token=${token}`);
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const created = service();

  const response = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  }, ACTOR_ID);

  assert.deepEqual(response.summary, {
    total: 1,
    succeeded: 0,
    failed: 0,
    unconfirmed: 1,
    skipped: 0,
    status: 'unconfirmed',
  });
  assert.equal(response.results[0].status, 'unconfirmed');
  assert.equal(Object.prototype.hasOwnProperty.call(response.results[0], 'success'), false);
  assert.match(response.results[0].message ?? '', /Verifica estado antes de reintentar\./);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(created.auditUpdates), new RegExp(token));
});

test('bind marks invalid JSON after POST as unconfirmed', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (async (input) => {
    if (String(input).endsWith(DIDI_BIND_STORE_PATH)) {
      return new Response('{not-json', { status: 502 });
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  }) as typeof fetch;
  const created = service();

  const response = await created.value.bind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'VINCULAR 1 TIENDAS',
  }, ACTOR_ID);

  assert.equal(response.summary.unconfirmed, 1);
  assert.equal(response.summary.failed, 0);
  assert.equal(response.results[0].status, 'unconfirmed');
  assert.equal(Object.prototype.hasOwnProperty.call(response.results[0], 'success'), false);
});

test('unbind keeps an auth failure before POST as failed', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let unbindPosts = 0;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 1,
          page_size: 100,
          total_page: 1,
          total_cnt: 1,
          shops: [{ shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 }],
        },
      }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 10002, errmsg: 'refresh rejected' }), { status: 200 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) unbindPosts += 1;
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const created = service();

  const response = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  }, ACTOR_ID);

  assert.equal(unbindPosts, 0);
  assert.equal(response.summary.failed, 1);
  assert.equal(response.summary.unconfirmed, 0);
  assert.equal(response.results[0].status, 'failed');
  assert.equal(response.results[0].success, false);
});
