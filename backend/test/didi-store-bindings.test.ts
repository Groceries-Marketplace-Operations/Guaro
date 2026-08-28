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
  exactConfirmation,
  fingerprintBindingBatch,
  isExplicitBindResponse,
  normalizeBindResults,
  redactDidiValue,
  stringifyDidiJsonWithInt64,
} from '../src/file-integrations/didi-store-bindings.util';

const APP_ID = '5764607654490537999';
const PRODUCTION_APP_ID = '5764607654490537888';
const SECRET = 'test-secret-never-real-000000000000';
const KEY = '11'.repeat(32);
const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ROLES = [AccountRole.admin];
const SUPER_ADMIN_ROLES = [AccountRole.super_admin];
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

function service(options: {
  appName?: string;
  appId?: string;
  bindingEnvironment?: 'TEST' | 'PRODUCTION' | string | null;
  allowlistedAppIds?: string;
  auditCreateError?: Error;
  auditUpdateError?: Error;
  writesEnabled?: boolean;
  productionBindEnabled?: boolean;
  productionUnbindEnabled?: boolean;
  localShopCount?: number;
  localShops?: Array<{
    shopId: string;
    appShopId: string;
    applicationId: string | null;
    name?: string | null;
    city?: string | null;
    brandId?: string;
    brandName?: string;
    deletedAt?: Date | null;
    brandDeletedAt?: Date | null;
  }>;
} = {}) {
  const auditCreates: unknown[] = [];
  const auditUpdates: unknown[] = [];
  const shopFindManyCalls: unknown[] = [];
  const shopCountCalls: unknown[] = [];
  const prisma = {
    application: {
      findFirst: async () => ({
        id: APPLICATION_ID,
        appId: options.appId ?? APP_ID,
        appName: options.appName ?? 'MX_T_CircleK',
        country: 'MX',
        appSecret: encrypt(SECRET, KEY),
        didiBindingEnvironment: options.bindingEnvironment === undefined ? 'TEST' : options.bindingEnvironment,
      }),
    },
    shop: {
      findMany: async (input: unknown) => {
        shopFindManyCalls.push(input);
        return (options.localShops ?? []).map(shop => ({
          shopId: shop.shopId,
          appShopId: shop.appShopId,
          name: shop.name ?? null,
          city: shop.city ?? null,
          deletedAt: shop.deletedAt ?? null,
          brand: {
            id: shop.brandId ?? '44444444-4444-4444-8444-444444444444',
            brandName: shop.brandName ?? 'Circle K',
            applicationId: shop.applicationId,
            deletedAt: shop.brandDeletedAt ?? null,
          },
        }));
      },
      count: async (input: unknown) => {
        shopCountCalls.push(input);
        return options.localShopCount ?? options.localShops?.length ?? 0;
      },
    },
    accessControlAudit: {
      create: async (input: unknown) => {
        if (options.auditCreateError) throw options.auditCreateError;
        auditCreates.push(input);
        return { id: 'audit-1' };
      },
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
    get: (key: string, defaultValue: string) => {
      if (key === 'DIDI_STORE_BINDINGS_TEST_APP_IDS') return options.allowlistedAppIds ?? APP_ID;
      if (key === 'DIDI_STORE_BINDINGS_ENABLED') return String(options.writesEnabled ?? true);
      if (key === 'DIDI_STORE_BINDINGS_PRODUCTION_BIND_ENABLED') return String(options.productionBindEnabled ?? false);
      if (key === 'DIDI_STORE_BINDINGS_PRODUCTION_UNBIND_ENABLED') return String(options.productionUnbindEnabled ?? false);
      return defaultValue;
    },
  };
  return {
    value: new DidiStoreBindingsService(prisma as never, config as never),
    auditCreates,
    auditUpdates,
    shopFindManyCalls,
    shopCountCalls,
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

test('production confirmation is bound to the app_id and exact Unbind shop_id', () => {
  const batch = [
    { shopId: SHOP_2, appShopId: '002' },
    { shopId: SHOP_1, appShopId: '001' },
  ];
  const canonical = [`${SHOP_1}\u0000001`, `${SHOP_2}\u0000002`].join('\n');
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12).toUpperCase();
  assert.equal(fingerprintBindingBatch(batch), fingerprint);
  assert.equal(exactConfirmation('bind', batch), 'VINCULAR 2 TIENDAS');
  assert.equal(
    exactConfirmation('bind', batch, 'production', PRODUCTION_APP_ID),
    `PRODUCCION VINCULAR 2 TIENDAS APP_ID ${PRODUCTION_APP_ID} LOTE ${fingerprint}`,
  );
  assert.equal(
    exactConfirmation('unbind', [{ shopId: SHOP_1, appShopId: '001' }], 'production', PRODUCTION_APP_ID),
    `PRODUCCION DESVINCULAR 1 TIENDAS APP_ID ${PRODUCTION_APP_ID} SHOP_ID ${SHOP_1}`,
  );
  assert.throws(
    () => exactConfirmation('unbind', [{ appShopId: '001' }], 'production', PRODUCTION_APP_ID),
    /shop_id is required/,
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
    remotePageNo: 1,
  });
  const missingRemotePage = plainToInstance(UnbindDidiStoresDto, {
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
  });

  assert.ok((await validate(tooMany)).some(error => error.property === 'shops'));
  assert.ok((await validate(missingUnbindShopId)).some(error => error.property === 'shops'));
  assert.ok((await validate(tooManyUnbind)).some(error => error.property === 'shops'));
  assert.ok((await validate(missingRemotePage)).some(error => error.property === 'remotePageNo'));
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
  }, ACTOR_ID, ADMIN_ROLES);

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

test('registered production applications can list shops and Bind only with every production control', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls: string[] = [];
  global.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { page_no: 1, page_size: 100, total_cnt: 1, shops: [
          { shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 },
        ] },
      }), { status: 200 });
    }
    if (url.endsWith(DIDI_BIND_STORE_PATH)) {
      return new Response(JSON.stringify({
        success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
        failure_list: [],
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const readOnly = service({
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION',
  });
  const listed = await readOnly.value.listBoundStores({
    applicationId: APPLICATION_ID,
    pageNo: 1,
    pageSize: 100,
  }, SUPER_ADMIN_ROLES);
  assert.equal(listed.application.environment, 'production');
  assert.equal(listed.guards.canBind, false);
  assert.equal(listed.shops.length, 1);

  const enabled = service({
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION',
    productionBindEnabled: true,
    localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID }],
  });
  const reason = 'CHG-2048 approved production onboarding';
  const shops = [{ shopId: SHOP_1, appShopId: '001' }];
  const response = await enabled.value.bind({
    applicationId: APPLICATION_ID,
    shops,
    confirmation: exactConfirmation('bind', shops, 'production', PRODUCTION_APP_ID),
    reason,
    productionAcknowledged: true,
  }, ACTOR_ID, SUPER_ADMIN_ROLES);

  assert.equal(calls.filter(url => url.endsWith(DIDI_BIND_STORE_PATH)).length, 1);
  assert.equal(response.application.environment, 'production');
  assert.equal(response.summary.succeeded, 1);
  assert.match(JSON.stringify(enabled.auditCreates), /CHG-2048 approved production onboarding/);
  assert.match(JSON.stringify(enabled.auditCreates), /productionAcknowledged/);
});

test('shop-list capabilities reflect the effective execute permission', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (async (input) => {
    if (String(input).endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { page_no: 1, page_size: 100, total_cnt: 0, shops: [] },
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  }) as typeof fetch;
  const created = service();
  const dto = { applicationId: APPLICATION_ID, pageNo: 1, pageSize: 100 };

  const denied = await created.value.listBoundStores(dto, ADMIN_ROLES, false);
  const allowed = await created.value.listBoundStores(dto, ADMIN_ROLES, true);

  assert.equal(denied.guards.executePermissionAllowed, false);
  assert.equal(denied.guards.canBind, false);
  assert.equal(denied.guards.canUnbind, false);
  assert.equal(allowed.guards.executePermissionAllowed, true);
  assert.equal(allowed.guards.canBind, true);
  assert.equal(allowed.guards.canUnbind, true);
});

test('local Bind catalog searches and paginates 7,000 shops without a DiDi request', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let providerCalls = 0;
  global.fetch = (async () => {
    providerCalls += 1;
    throw new Error('local catalog must not call DiDi');
  }) as typeof fetch;

  const created = service({
    localShopCount: 7_000,
    localShops: [{
      shopId: SHOP_1,
      appShopId: '001',
      applicationId: APPLICATION_ID,
      name: 'Needle Store',
      city: 'Monterrey',
      brandName: 'Circle K Norte',
    }],
  });
  const response = await created.value.listLocalStores({
    applicationId: APPLICATION_ID,
    q: '  needle  ',
    pageNo: 70,
    pageSize: 100,
  }, ADMIN_ROLES, true);

  assert.equal(providerCalls, 0);
  assert.equal(response.source, 'local');
  assert.equal(response.total, 7_000);
  assert.equal(response.totalPages, 70);
  assert.equal(response.pageNo, 70);
  assert.equal(response.shops[0].shopId, SHOP_1);
  assert.equal(response.shops[0].brandName, 'Circle K Norte');
  assert.equal(response.guards.canBind, true);
  assert.equal(created.shopFindManyCalls.length, 2);
  assert.equal(created.shopCountCalls.length, 1);
  const query = created.shopFindManyCalls[0] as {
    where: { brand: { is: { applicationId: string; deletedAt: null } }; OR: unknown[] };
    skip: number;
    take: number;
  };
  assert.equal(query.where.brand.is.applicationId, APPLICATION_ID);
  assert.equal(query.where.brand.is.deletedAt, null);
  assert.equal(query.skip, 6_900);
  assert.equal(query.take, 100);
  assert.match(JSON.stringify(query.where.OR), /needle/);
  assert.match(JSON.stringify(query.where.OR), /brandName/);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET));
});

test('duplicate active appShopId mappings are marked locally and block Bind and Unbind before DiDi', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let providerCalls = 0;
  global.fetch = (async () => {
    providerCalls += 1;
    throw new Error('conflicted mappings must not call DiDi');
  }) as typeof fetch;
  const created = service({
    localShops: [
      {
        shopId: SHOP_1,
        appShopId: 'duplicate-001',
        applicationId: APPLICATION_ID,
        brandId: '44444444-4444-4444-8444-444444444444',
        brandName: 'Brand One',
      },
      {
        shopId: SHOP_2,
        appShopId: 'duplicate-001',
        applicationId: APPLICATION_ID,
        brandId: '55555555-5555-4555-8555-555555555555',
        brandName: 'Brand Two',
      },
    ],
  });

  const catalog = await created.value.listLocalStores({
    applicationId: APPLICATION_ID,
    pageNo: 1,
    pageSize: 100,
  }, ADMIN_ROLES, true);
  assert.ok(catalog.shops.every(shop => shop.mappingConflict));

  await assert.rejects(
    () => created.value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: 'duplicate-001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /maps to multiple active shopIds/,
  );
  await assert.rejects(
    () => created.value.unbind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: 'duplicate-001' }],
      confirmation: 'DESVINCULAR 1 TIENDAS',
      remotePageNo: 1,
    }, ACTOR_ID, ADMIN_ROLES),
    /maps to multiple active shopIds/,
  );
  assert.equal(providerCalls, 0);
});

test('remote page browsing caches and deduplicates the same Application page', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let providerCalls = 0;
  let notifyStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  global.fetch = (async (input) => {
    if (!String(input).endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      throw new Error(`Unexpected URL ${String(input)}`);
    }
    providerCalls += 1;
    notifyStarted();
    await gate;
    return new Response(JSON.stringify({
      errno: 0,
      data: {
        page_no: 37,
        page_size: 100,
        total_page: 70,
        total_cnt: 7_000,
        shops: [{ shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 }],
      },
    }), { status: 200 });
  }) as typeof fetch;
  const created = service();
  const dto = { applicationId: APPLICATION_ID, pageNo: 37, pageSize: 100 };

  const first = created.value.listBoundStores(dto, ADMIN_ROLES, true);
  await started;
  const second = created.value.listBoundStores(dto, ADMIN_ROLES, true);
  release();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  const thirdResponse = await created.value.listBoundStores(dto, ADMIN_ROLES, true);

  assert.equal(providerCalls, 1);
  assert.equal(firstResponse.remoteSnapshot.cacheStatus, 'miss');
  assert.equal(secondResponse.remoteSnapshot.cacheStatus, 'shared');
  assert.equal(thirdResponse.remoteSnapshot.cacheStatus, 'hit');
  assert.equal(firstResponse.remoteSnapshot.fetchedAt, thirdResponse.remoteSnapshot.fetchedAt);
  assert.equal(thirdResponse.totalPages, 70);
});

test('a completed Bind invalidates cached remote pages for its Application', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let listCalls = 0;
  let bindPosts = 0;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      listCalls += 1;
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 2,
          page_size: 100,
          total_page: 70,
          total_cnt: 7_000,
          shops: [{ shop_id: SHOP_1, app_shop_id: '001', bound_flag: 0 }],
        },
      }), { status: 200 });
    }
    if (url.endsWith(DIDI_BIND_STORE_PATH)) {
      bindPosts += 1;
      return new Response(JSON.stringify({
        success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
        failure_list: [],
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const created = service();
  const listDto = { applicationId: APPLICATION_ID, pageNo: 2, pageSize: 100 };

  await created.value.listBoundStores(listDto, ADMIN_ROLES, true);
  const cached = await created.value.listBoundStores(listDto, ADMIN_ROLES, true);
  assert.equal(cached.remoteSnapshot.cacheStatus, 'hit');
  await created.value.bind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'VINCULAR 1 TIENDAS',
  }, ACTOR_ID, ADMIN_ROLES);
  const refreshed = await created.value.listBoundStores(listDto, ADMIN_ROLES, true);

  assert.equal(bindPosts, 1);
  assert.equal(listCalls, 2);
  assert.equal(refreshed.remoteSnapshot.cacheStatus, 'miss');
});

test('production writes fail closed for role, switch, reason, acknowledgement and confirmation', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const shops = [{ shopId: SHOP_1, appShopId: '001' }];
  const dto = {
    applicationId: APPLICATION_ID,
    shops,
    confirmation: exactConfirmation('bind', shops, 'production', PRODUCTION_APP_ID),
    reason: 'CHG-2048 approved production onboarding',
    productionAcknowledged: true,
  };

  await assert.rejects(
    () => service({
      appName: 'MX_CircleK', appId: PRODUCTION_APP_ID, bindingEnvironment: 'PRODUCTION', productionBindEnabled: true,
    })
      .value.bind(dto, ACTOR_ID, ADMIN_ROLES),
    /requires the super_admin role/,
  );
  await assert.rejects(
    () => service({ appName: 'MX_CircleK', appId: PRODUCTION_APP_ID, bindingEnvironment: 'PRODUCTION' })
      .value.bind(dto, ACTOR_ID, SUPER_ADMIN_ROLES),
    /PRODUCTION_BIND_ENABLED/,
  );
  await assert.rejects(
    () => service({
      appName: 'MX_CircleK', appId: PRODUCTION_APP_ID, bindingEnvironment: 'PRODUCTION', productionBindEnabled: true,
    })
      .value.bind({ ...dto, reason: undefined }, ACTOR_ID, SUPER_ADMIN_ROLES),
    /reason or ticket/,
  );
  await assert.rejects(
    () => service({
      appName: 'MX_CircleK', appId: PRODUCTION_APP_ID, bindingEnvironment: 'PRODUCTION', productionBindEnabled: true,
    })
      .value.bind({ ...dto, productionAcknowledged: false }, ACTOR_ID, SUPER_ADMIN_ROLES),
    /productionAcknowledged must be true/,
  );
  await assert.rejects(
    () => service({
      appName: 'MX_CircleK', appId: PRODUCTION_APP_ID, bindingEnvironment: 'PRODUCTION', productionBindEnabled: true,
    })
      .value.bind({ ...dto, confirmation: 'VINCULAR 1 TIENDAS' }, ACTOR_ID, SUPER_ADMIN_ROLES),
    /Confirmation must exactly match: PRODUCCION/,
  );
  assert.equal(calls, 0);
});

test('production Unbind uses its independent switch and exact single-shop confirmation', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let unbindPosts = 0;
  let listCalls = 0;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      listCalls += 1;
      return new Response(JSON.stringify({
        errno: 0,
        data: { page_no: 1, page_size: 100, total_cnt: 1, shops: [
          { shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 },
        ] },
      }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-secret' } }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth-secret' } }), { status: 200 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) {
      unbindPosts += 1;
      return new Response(JSON.stringify({ errno: 0, data: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const created = service({
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION',
    productionBindEnabled: false,
    productionUnbindEnabled: true,
    localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID }],
  });
  const shops = [{ shopId: SHOP_1, appShopId: '001' }];
  const response = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops,
    confirmation: exactConfirmation('unbind', shops, 'production', PRODUCTION_APP_ID),
    reason: 'INC-4096 approved production unlink',
    productionAcknowledged: true,
    remotePageNo: 1,
  }, ACTOR_ID, SUPER_ADMIN_ROLES);

  assert.equal(unbindPosts, 1);
  assert.equal(listCalls, 1);
  assert.equal(response.summary.succeeded, 1);
  assert.equal(response.summary.failed, 0);
});

test('production Unbind revalidates the exact remote page mapping before auth or POST', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let listCalls = 0;
  let authCalls = 0;
  let unbindPosts = 0;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      listCalls += 1;
      return new Response(JSON.stringify({
        errno: 0,
        data: { page_no: 7, page_size: 100, total_cnt: 1, shops: [
          listCalls === 1
            ? { shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 }
            : { shop_id: SHOP_2, app_shop_id: '001', bound_flag: 1 },
        ] },
      }), { status: 200 });
    }
    if (url.includes('/authtoken/')) authCalls += 1;
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) unbindPosts += 1;
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const created = service({
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION',
    productionUnbindEnabled: true,
    localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID }],
  });
  const shops = [{ shopId: SHOP_1, appShopId: '001' }];
  const cached = await created.value.listBoundStores({
    applicationId: APPLICATION_ID,
    pageNo: 7,
    pageSize: 100,
  }, SUPER_ADMIN_ROLES, true);
  assert.equal(cached.remoteSnapshot.cacheStatus, 'miss');
  const response = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops,
    confirmation: exactConfirmation('unbind', shops, 'production', PRODUCTION_APP_ID),
    reason: 'INC-4097 approved production unlink',
    productionAcknowledged: true,
    remotePageNo: 7,
  }, ACTOR_ID, SUPER_ADMIN_ROLES);

  assert.equal(listCalls, 2);
  assert.equal(authCalls, 0);
  assert.equal(unbindPosts, 0);
  assert.equal(response.summary.failed, 1);
  assert.match(response.results[0].message ?? '', /Remote mapping mismatch.*shopId/);
});

test('production Unbind requires a freshly loaded remote page before provider access', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const created = service({
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION',
    productionUnbindEnabled: true,
    localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID }],
  });
  const shops = [{ shopId: SHOP_1, appShopId: '001' }];
  await assert.rejects(
    () => created.value.unbind({
      applicationId: APPLICATION_ID,
      shops,
      confirmation: exactConfirmation('unbind', shops, 'production', PRODUCTION_APP_ID),
      reason: 'INC-4098 approved production unlink',
      productionAcknowledged: true,
    } as unknown as UnbindDidiStoresDto, ACTOR_ID, SUPER_ADMIN_ROLES),
    /requires remotePageNo/,
  );
  assert.equal(calls, 0);
});

test('local shop mappings cannot cross Applications before a provider request', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;

  await assert.rejects(
    () => service({
      localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: '33333333-3333-4333-8333-333333333333' }],
    }).value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /belongs to another Application/,
  );
  await assert.rejects(
    () => service({
      localShops: [{ shopId: SHOP_1, appShopId: 'LOCAL-001', applicationId: APPLICATION_ID }],
    }).value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: 'REQUEST-001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /local appShopId is LOCAL-001/,
  );
  assert.equal(calls, 0);
});

test('existing soft-deleted TEST mappings are rejected before a provider request', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;

  await assert.rejects(
    () => service({
      localShops: [{
        shopId: SHOP_1,
        appShopId: '001',
        applicationId: APPLICATION_ID,
        deletedAt: new Date('2026-01-01T00:00:00Z'),
      }],
    }).value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /soft-deleted locally/,
  );
  assert.equal(calls, 0);
});

test('unknown environment, TEST allowlist contradictions and non-decimal app_id fail before provider access', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const listDto = { applicationId: APPLICATION_ID, pageNo: 1, pageSize: 100 };

  await assert.rejects(
    () => service({ bindingEnvironment: null }).value.listBoundStores(listDto),
    /didiBindingEnvironment must be explicitly TEST or PRODUCTION/,
  );
  await assert.rejects(
    () => service({ bindingEnvironment: 'STAGING' }).value.listBoundStores(listDto),
    /didiBindingEnvironment must be explicitly TEST or PRODUCTION/,
  );
  await assert.rejects(
    () => service({
      appName: 'MX_CircleK',
      appId: APP_ID,
      bindingEnvironment: 'PRODUCTION',
    }).value.listBoundStores(listDto),
    /present in DIDI_STORE_BINDINGS_TEST_APP_IDS/,
  );
  await assert.rejects(
    () => service({
      appId: 'not-a-decimal-id',
      bindingEnvironment: 'TEST',
      allowlistedAppIds: 'not-a-decimal-id',
    }).value.listBoundStores(listDto),
    /app_id must be a decimal string/,
  );
  assert.equal(calls, 0);
});

test('production requires complete active local mappings assigned exactly to the selected Application', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const shops = [
    { shopId: SHOP_1, appShopId: '001' },
    { shopId: SHOP_2, appShopId: '002' },
  ];
  const dto = {
    applicationId: APPLICATION_ID,
    shops,
    confirmation: exactConfirmation('bind', shops, 'production', PRODUCTION_APP_ID),
    reason: 'CHG-8192 production batch approval',
    productionAcknowledged: true,
  };
  const productionOptions = {
    appName: 'MX_CircleK',
    appId: PRODUCTION_APP_ID,
    bindingEnvironment: 'PRODUCTION' as const,
    productionBindEnabled: true,
  };

  await assert.rejects(
    () => service({
      ...productionOptions,
      localShops: [{ shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID }],
    }).value.bind(dto, ACTOR_ID, SUPER_ADMIN_ROLES),
    new RegExp(`shopId ${SHOP_2} has no local mapping`),
  );
  await assert.rejects(
    () => service({
      ...productionOptions,
      localShops: [
        { shopId: SHOP_1, appShopId: '001', applicationId: APPLICATION_ID },
        { shopId: SHOP_2, appShopId: '002', applicationId: null },
      ],
    }).value.bind(dto, ACTOR_ID, SUPER_ADMIN_ROLES),
    new RegExp(`shopId ${SHOP_2} has no Application assigned locally`),
  );
  assert.equal(calls, 0);
});

test('production Bind confirmation rejects a different batch with the same item count', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const confirmedBatch = [{ shopId: SHOP_1, appShopId: '001' }];
  const submittedBatch = [{ shopId: SHOP_2, appShopId: '002' }];
  const confirmedPhrase = exactConfirmation('bind', confirmedBatch, 'production', PRODUCTION_APP_ID);
  const submittedPhrase = exactConfirmation('bind', submittedBatch, 'production', PRODUCTION_APP_ID);
  assert.notEqual(confirmedPhrase, submittedPhrase);

  await assert.rejects(
    () => service({
      appName: 'MX_CircleK',
      appId: PRODUCTION_APP_ID,
      bindingEnvironment: 'PRODUCTION',
      productionBindEnabled: true,
      localShops: [{ shopId: SHOP_2, appShopId: '002', applicationId: APPLICATION_ID }],
    }).value.bind({
      applicationId: APPLICATION_ID,
      shops: submittedBatch,
      confirmation: confirmedPhrase,
      reason: 'CHG-8193 production batch approval',
      productionAcknowledged: true,
    }, ACTOR_ID, SUPER_ADMIN_ROLES),
    new RegExp(`Confirmation must exactly match: ${submittedPhrase}`),
  );
  assert.equal(calls, 0);
});

test('master write kill switch blocks Bind and Unbind with zero provider calls', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const created = service({ writesEnabled: false });

  await assert.rejects(
    () => created.value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /writes are disabled/,
  );
  await assert.rejects(
    () => created.value.unbind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'DESVINCULAR 1 TIENDAS',
      remotePageNo: 1,
    }, ACTOR_ID, ADMIN_ROLES),
    /writes are disabled/,
  );
  assert.equal(calls, 0);
  assert.equal(created.auditCreates.length, 0);
});

test('audit creation is fail-closed before any mutating provider request', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const created = service({ auditCreateError: new Error('audit store unavailable') });

  await assert.rejects(
    () => created.value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
    /audit store unavailable/,
  );
  assert.equal(calls, 0);
  assert.equal(created.auditUpdates.length, 0);
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
    }, ACTOR_ID, ADMIN_ROLES),
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
      remotePageNo: 1,
    }, ACTOR_ID, ADMIN_ROLES),
    /At most 1 store is allowed/,
  );
  await assert.rejects(
    () => service({ appName: 'MX_T_CircleK', appId: '5764607654490537998' }).value.bind({
      applicationId: APPLICATION_ID,
      shops: [{ shopId: SHOP_1, appShopId: '001' }],
      confirmation: 'VINCULAR 1 TIENDAS',
    }, ACTOR_ID, ADMIN_ROLES),
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

  const first = created.value.bind(dto, ACTOR_ID, ADMIN_ROLES);
  await started;
  await assert.rejects(
    () => created.value.bind(dto, ACTOR_ID, ADMIN_ROLES),
    /already running for this application/,
  );
  releaseFetch();
  await first;
  const third = await created.value.bind(dto, ACTOR_ID, ADMIN_ROLES);
  assert.equal(third.summary.succeeded, 1);
});

test('unbind verifies the exact remote mapping before auth and redacts provider token errors', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls: string[] = [];
  const listBodies: string[] = [];
  const token = 'unbind-auth-token-secret';
  global.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      listBodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          page_no: 70,
          page_size: 100,
          total_page: 70,
          total_cnt: 7_000,
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
    remotePageNo: 70,
  }, ACTOR_ID, ADMIN_ROLES);

  assert.match(calls[0], new RegExp(`${DIDI_LIST_BOUND_STORES_PATH}$`));
  assert.equal(listBodies.length, 1);
  assert.match(listBodies[0], /"page_no":70/);
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
    remotePageNo: 1,
  }, ACTOR_ID, ADMIN_ROLES);

  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`${DIDI_LIST_BOUND_STORES_PATH}$`));
  assert.equal(response.summary.failed, 1);
  assert.match(response.results[0].message ?? '', /mapping mismatch/i);
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
  }, ACTOR_ID, ADMIN_ROLES);

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
    remotePageNo: 1,
  }, ACTOR_ID, ADMIN_ROLES);

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

test('unbind treats HTTP 200 errno=0 without data=true as unconfirmed', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
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
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth-secret' } }), { status: 200 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH)) {
      return new Response(JSON.stringify({ errno: 0, data: false }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const response = await service().value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
    remotePageNo: 1,
  }, ACTOR_ID, ADMIN_ROLES);

  assert.equal(response.summary.unconfirmed, 1);
  assert.equal(response.summary.failed, 0);
  assert.equal(response.results[0].status, 'unconfirmed');
  assert.match(response.results[0].message ?? '', /errno=0 without data=true/);
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
  }, ACTOR_ID, ADMIN_ROLES);

  assert.equal(response.summary.unconfirmed, 1);
  assert.equal(response.summary.failed, 0);
  assert.equal(response.results[0].status, 'unconfirmed');
  assert.equal(Object.prototype.hasOwnProperty.call(response.results[0], 'success'), false);
});

test('non-2xx responses after mutating POST stay unconfirmed even with success-looking bodies', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let mode: 'bind' | 'unbind' = 'bind';
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(DIDI_LIST_BOUND_STORES_PATH)) {
      return new Response(JSON.stringify({
        errno: 0,
        data: { page_no: 1, page_size: 100, total_cnt: 1, shops: [
          { shop_id: SHOP_1, app_shop_id: '001', bound_flag: 1 },
        ] },
      }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-secret' } }), { status: 200 });
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'token-secret' } }), { status: 200 });
    }
    if (url.endsWith(DIDI_BIND_STORE_PATH) && mode === 'bind') {
      return new Response(JSON.stringify({
        success_list: [{ shop_id: SHOP_1, app_shop_id: '001' }],
        failure_list: [],
      }), { status: 502 });
    }
    if (url.endsWith(DIDI_UNBIND_STORE_PATH) && mode === 'unbind') {
      return new Response(JSON.stringify({ errno: 0, data: true }), { status: 502 });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;

  const created = service();
  const bind = await created.value.bind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'VINCULAR 1 TIENDAS',
  }, ACTOR_ID, ADMIN_ROLES);
  assert.equal(bind.summary.unconfirmed, 1);
  assert.equal(bind.summary.succeeded, 0);

  mode = 'unbind';
  const unbind = await created.value.unbind({
    applicationId: APPLICATION_ID,
    shops: [{ shopId: SHOP_1, appShopId: '001' }],
    confirmation: 'DESVINCULAR 1 TIENDAS',
    remotePageNo: 1,
  }, ACTOR_ID, ADMIN_ROLES);
  assert.equal(unbind.summary.unconfirmed, 1);
  assert.equal(unbind.summary.succeeded, 0);
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
    remotePageNo: 1,
  }, ACTOR_ID, ADMIN_ROLES);

  assert.equal(unbindPosts, 0);
  assert.equal(response.summary.failed, 1);
  assert.equal(response.summary.unconfirmed, 0);
  assert.equal(response.results[0].status, 'failed');
  assert.equal(response.results[0].success, false);
});
