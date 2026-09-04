import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AccountRole } from '@prisma/client';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '../src/access-control/permissions.decorator';
import {
  ApplicationShopInventoryController,
} from '../src/application-shop-inventory/application-shop-inventory.controller';
import {
  ApplicationShopInventoryService,
  normalizeRemoteInventoryShop,
  parseProviderErrno,
} from '../src/application-shop-inventory/application-shop-inventory.service';
import {
  AddApplicationShopInventoryDto,
} from '../src/application-shop-inventory/dto/application-shop-inventory.dto';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';

test('shop inventory controller is strictly super-admin only and declares no overriding permission', () => {
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, ApplicationShopInventoryController), [AccountRole.super_admin]);
  assert.equal(Reflect.getMetadata(PERMISSIONS_KEY, ApplicationShopInventoryController), undefined);

  for (const method of ['options', 'list', 'add', 'fetch', 'brands', 'shops', 'remove']) {
    const handler = ApplicationShopInventoryController.prototype[
      method as keyof ApplicationShopInventoryController
    ];
    assert.equal(Reflect.getMetadata(PERMISSIONS_KEY, handler), undefined, `${method} must not override the role gate`);
  }
});

test('add inventory DTO only accepts UUID application identifiers', async () => {
  const invalid = new AddApplicationShopInventoryDto();
  invalid.applicationId = '5764600000000000001';
  assert.equal((await validate(invalid)).length, 1);

  const valid = new AddApplicationShopInventoryDto();
  valid.applicationId = '11111111-1111-4111-8111-111111111111';
  assert.equal((await validate(valid)).length, 0);
});

test('remote shop normalization preserves int64 strings and optional brand metadata', () => {
  assert.deepEqual(normalizeRemoteInventoryShop({
    shop_id: '5764607688097661019',
    app_shop_id: '00109',
    shop_name: 'Sucursal Centro',
    brand_info: { id: '5764607529999999999', name: 'Brand Uno' },
    city_name: 'Bogotá',
    addr: 'Calle 1',
  }), {
    shopId: '5764607688097661019',
    appShopId: '00109',
    shopName: 'Sucursal Centro',
    brandExternalId: '5764607529999999999',
    brandName: 'Brand Uno',
    city: 'Bogotá',
    address: 'Calle 1',
  });
  assert.equal(normalizeRemoteInventoryShop({ shop_id: '1' }), null);
});

test('provider errno parsing accepts only explicit integer values', () => {
  assert.equal(parseProviderErrno(0), 0);
  assert.equal(parseProviderErrno('0'), 0);
  assert.equal(parseProviderErrno(10005), 10005);
  assert.equal(parseProviderErrno(null), null);
  assert.equal(parseProviderErrno(''), null);
  assert.equal(parseProviderErrno(false), null);
  assert.equal(parseProviderErrno('0.0'), null);
});

test('migration creates isolated snapshot tables with cascading inventory cleanup', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260905010000_super_admin_shop_inventory/migration.sql',
  ), 'utf8');
  assert.match(migration, /CREATE TABLE "application_shop_inventory"/);
  assert.match(migration, /CREATE TABLE "application_shop_inventory_shop"/);
  assert.match(migration, /application_shop_inventory_application_id_key/);
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.doesNotMatch(migration, /ALTER TABLE "application"\s+DROP/i);
  assert.doesNotMatch(migration, /ALTER TABLE "brand"\s+DROP/i);
  assert.doesNotMatch(migration, /ALTER TABLE "shop"\s+DROP/i);
});

test('inventory worker is read-only against DiDi and never calls mutating endpoints', () => {
  const source = readFileSync(resolve(
    __dirname,
    '../src/application-shop-inventory/application-shop-inventory.service.ts',
  ), 'utf8');
  assert.match(source, /DIDI_LIST_BOUND_STORES_PATH/);
  assert.doesNotMatch(source, /shop\/setStatus|shop\/update|authorization\/shopBind|shop\/unbind|uploadGrocery/);
  assert.doesNotMatch(source, /getAuthToken|shop\/detail/);
  assert.match(source, /assertApplicationActive\(applicationId\)/);
  assert.match(source, /current\.application\.deletedAt/);
});

test('a credential decryption failure terminalizes the claimed run and keeps it retryable', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    applicationShopInventory: {
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        const where = args.where as Record<string, unknown> | undefined;
        return { count: where?.updatedAt ? 0 : 1 };
      },
      findFirst: async () => ({ id: '11111111-1111-4111-8111-111111111111', activeRunId: '22222222-2222-4222-8222-222222222222' }),
      findUnique: async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        activeRunId: '22222222-2222-4222-8222-222222222222',
        fetchStatus: 'running',
        application: {
          id: '33333333-3333-4333-8333-333333333333',
          appId: '5764600000000000001',
          appSecret: 'invalid-ciphertext',
        },
      }),
    },
  };
  const config = { getOrThrow: () => '00'.repeat(32) };
  const coordinator = { withShopListRateLimit: async () => { throw new Error('must not call DiDi'); } };
  const service = new ApplicationShopInventoryService(
    prisma as never,
    config as never,
    coordinator as never,
  );

  await service.processQueuedFetch();

  assert.equal(updates.length, 3);
  const terminal = updates[updates.length - 1].data as Record<string, unknown>;
  assert.deepEqual(terminal.fetchStatus, 'failed');
  assert.equal(terminal.activeRunId, null);
  assert.match(String(terminal.lastError), /invalid|buffer|argument/i);
});
