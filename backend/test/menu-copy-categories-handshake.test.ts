import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_GROCERY_CATEGORY_NAMES,
  buildFlatGroceryUploads,
} from '../src/file-integrations/grocery-destination-menu.util';
import { MenuCopyService } from '../src/file-integrations/menu-copy.service';

function item(id: string) {
  return { app_item_id: id, upc: `upc-${id}`, price: 100, image_url: 'discarded' };
}

test('Cross App uses the approved category list sequentially without classifying items', () => {
  assert.equal(ALLOWED_GROCERY_CATEGORY_NAMES.length, 55);
  assert.deepEqual(ALLOWED_GROCERY_CATEGORY_NAMES.slice(0, 5), [
    'Panadería y Galletas', 'Botanas', 'Comidas Preparadas', 'Bebidas', 'Cerveza',
  ]);
  const sourceMenu = {
    menus: [{ app_menu_id: 'menu-1', menu_name: 'Menu', app_category_ids: ['old-1', 'old-2'] }],
    categories: [
      { app_category_id: 'old-1', category_name: 'Panaderia y Galletas', app_item_ids: ['item-1', 'item-2'] },
      { app_category_id: 'old-2', category_name: 'Not approved', app_item_ids: ['item-3'] },
    ],
  };

  const uploads = buildFlatGroceryUploads(sourceMenu, [item('item-1'), item('item-2'), item('item-3')], 2, true);

  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].categories.map(category => category.category_name), [
    'Panadería y Galletas',
    'Botanas',
  ]);
  assert.deepEqual(uploads[0].menus[0].app_category_ids, ['Cate_Grocery_1', 'Cate_Grocery_2']);
  assert.equal(uploads[0].items.length, 3);
  assert.equal(uploads[0].items.some(entry => 'image_url' in entry), false);
  assert.deepEqual(uploads[0].categories.map(category => category.app_item_ids), [
    ['item-1', 'item-2'],
    ['item-3'],
  ]);
});

test('6,565 items are sent in one upload with category blocks of at most 3,500 items', () => {
  const selectedItems = Array.from({ length: 6565 }, (_, index) => item(`item-${index + 1}`));
  const sourceMenu = {
    menus: [{ app_menu_id: 'menu-1', menu_name: 'Menu', app_category_ids: ['source-category'] }],
    categories: [{
      app_category_id: 'source-category',
      category_name: 'Bebidas',
      app_item_ids: selectedItems.map(entry => entry.app_item_id),
    }],
  };

  const uploads = buildFlatGroceryUploads(sourceMenu, selectedItems, undefined, true);

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].categories.length, 2);
  assert.deepEqual(uploads[0].categories.map(category => category.category_name), ['Panadería y Galletas', 'Botanas']);
  assert.deepEqual(uploads[0].categories.map(category => (category.app_item_ids as string[]).length), [3500, 3065]);
  assert.equal(uploads[0].items.length, 6565);
  assert.deepEqual(uploads[0].menus[0].app_category_ids, ['Cate_Grocery_1', 'Cate_Grocery_2']);
});

function handshakeFixture() {
  const inserted: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const prisma = {
    brand: {
      findFirst: async () => ({
        applicationId: '11111111-1111-4111-8111-111111111111',
        application: { id: '11111111-1111-4111-8111-111111111111' },
        shops: [{ shopId: '5764600000000000001' }, { shopId: '5764600000000000002' }],
      }),
    },
    menuCopyExecution: {
      findMany: async () => [],
      createManyAndReturn: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        inserted.push(...data);
        return data.map((entry, index) => ({ id: `execution-${index + 1}`, ...entry }));
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const queue = { addBulk: async (jobs: Array<Record<string, unknown>>) => { queued.push(...jobs); } };
  return { service: new MenuCopyService(prisma as never, queue as never), inserted, queued };
}

test('forced brand handshake creates one replace execution per store using the same store as source and target', async () => {
  const { service, inserted, queued } = handshakeFixture();
  const result = await service.createHandshake({
    brandId: '22222222-2222-4222-8222-222222222222',
    mode: 'all_brand',
  }, '33333333-3333-4333-8333-333333333333');

  assert.equal(result.created, 2);
  assert.equal(queued.length, 2);
  assert.equal(inserted.every(entry => entry.sourceApplicationId === entry.targetApplicationId), true);
  assert.equal(inserted.every(entry => entry.sourceShopId === entry.targetShopId), true);
  assert.equal(inserted.every(entry => entry.mergePolicy === 1 && entry.uploadEndpoint === 'uploadGrocery'), true);
});

test('forced handshake rejects stores that do not belong to the selected brand', async () => {
  const { service } = handshakeFixture();
  await assert.rejects(
    service.createHandshake({
      brandId: '22222222-2222-4222-8222-222222222222',
      mode: 'shop_list',
      shopIds: ['5764600000000000999'],
    }, '33333333-3333-4333-8333-333333333333'),
    (error: unknown) => error instanceof BadRequestException && /do not belong/.test(error.message),
  );
});
