import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildActivityPriceMenuUpload,
  prepareActivityPriceUpdates,
  shouldRetryActivityPriceUpload,
  verifyActivityPriceUpdates,
} from '../src/file-integrations/upc-activity-price.util';

test('retries terminal failed, partial, or unverified-success tasks only while safe work remains', () => {
  const base = { confirmedCount: 0, expectedCount: 1, pendingUpdateCount: 1, attempt: 1, maxAttempts: 3 };
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 2 }), true);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 5 }), true);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 1 }), true);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 4 }), false);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 2, confirmedCount: 1 }), false);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 2, pendingUpdateCount: 0 }), false);
  assert.equal(shouldRetryActivityPriceUpload({ ...base, taskStatus: 2, attempt: 3 }), false);
});

test('preserves exported menu structure and changes only the target activity price', () => {
  const menu = {
    menus: [{ app_menu_id: 'menu-1', app_category_ids: ['cat-1'], custom: 'keep' }],
    categories: [{ app_category_id: 'cat-1', app_item_ids: ['a', 'b'], priority: 7 }],
    modifier_groups: [{ app_modifier_group_id: 'modifier-group-1', name: 'Extras', custom: 'keep' }],
    items: [
      { app_item_id: 'a', upc: '7707430870113', price: 20, activity_price: 10, custom: 'target' },
      { app_item_id: 'b', upc: 'other', price: 30, activity_price: 12, custom: 'other' },
    ],
  };

  const result = buildActivityPriceMenuUpload(menu, '7707430870113');

  assert.deepEqual(result.upload.menus, menu.menus);
  assert.deepEqual(result.upload.categories, menu.categories);
  assert.deepEqual(result.upload.modifierGroups, menu.modifier_groups);
  assert.deepEqual(result.upload.items, [
    { ...menu.items[0], activity_price: 20 },
    menu.items[1],
  ]);
  assert.equal(result.upload.items[1], menu.items[1]);
});

test('limits a retry transformation to the originally expected item ids', () => {
  const result = buildActivityPriceMenuUpload({
    menus: [{ app_menu_id: 'menu-1' }],
    categories: [{ app_category_id: 'cat-1' }],
    items: [
      { app_item_id: 'a', upc: '7707430870113', price: 20, activity_price: 10 },
      { app_item_id: 'new', upc: '7707430870113', price: 30, activity_price: 5 },
    ],
  }, '7707430870113', ['a']);

  assert.deepEqual(result.updates.map(item => item.app_item_id), ['a']);
  assert.equal(result.upload.items[0].activity_price, 20);
  assert.equal(result.upload.items[1].activity_price, 5);
});

test('changes only the requested UPC and preserves the item identity', () => {
  const result = prepareActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: '7707430870113', price: '19.5', activity_price: 10, item_name: 'Target' },
    { app_item_id: 'b', upc: 'other', price: 20, activity_price: 5, item_name: 'Other' },
  ] }, '7707430870113');
  assert.equal(result.updates.length, 1);
  assert.deepEqual(result.updates[0], {
    app_item_id: 'a',
    upc: '7707430870113',
    item_name: 'Target',
    short_desc: 'Target',
    price: 19.5,
    activity_price: 19.5,
    status: 1,
  });
  assert.equal(result.matches.length, 1);
});

test('skips an item whose activity price already equals its price', () => {
  const result = prepareActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: '7707430870113', price: 20, activity_price: '20' },
  ] }, '7707430870113');
  assert.equal(result.updates.length, 0);
  assert.equal(result.alreadyCurrent.length, 1);
});

test('does not upload invalid prices or items without an id', () => {
  const result = prepareActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: '7707430870113', price: 'not-a-price' },
    { upc: '7707430870113', price: 10 },
  ] }, '7707430870113');
  assert.equal(result.updates.length, 0);
});

test('confirms an expected item after its activity price matches numerically', () => {
  const result = verifyActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: '7707430870113', price: '19.50', activity_price: 19.5 },
  ] }, '7707430870113', ['a']);

  assert.deepEqual(result, {
    confirmedIds: ['a'],
    pendingUpdates: [],
    missingIds: [],
  });
});

test('rebuilds a pending update with the latest verified price', () => {
  const result = verifyActivityPriceUpdates({ items: [
    {
      app_item_id: 'a',
      upc: '7707430870113',
      price: '22.75',
      activity_price: '19.50',
      item_name: 'Target renamed',
      short_desc: 'Latest description',
      status: 0,
    },
  ] }, '7707430870113', ['a']);

  assert.deepEqual(result, {
    confirmedIds: [],
    pendingUpdates: [{
      app_item_id: 'a',
      upc: '7707430870113',
      item_name: 'Target renamed',
      short_desc: 'Latest description',
      price: 22.75,
      activity_price: 22.75,
      status: 0,
    }],
    missingIds: [],
  });
});

test('reports an expected item that disappeared without rebuilding it', () => {
  const result = verifyActivityPriceUpdates({ items: [] }, '7707430870113', ['gone']);

  assert.deepEqual(result, {
    confirmedIds: [],
    pendingUpdates: [],
    missingIds: ['gone'],
  });
});

test('reports an expected item whose UPC changed without rebuilding it', () => {
  const result = verifyActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: 'different-upc', price: 20, activity_price: 10 },
  ] }, '7707430870113', ['a']);

  assert.deepEqual(result, {
    confirmedIds: [],
    pendingUpdates: [],
    missingIds: ['a'],
  });
});

test('compares numeric strings by value instead of representation', () => {
  const result = verifyActivityPriceUpdates({ items: [
    { app_item_id: 'a', upc: '7707430870113', price: 20, activity_price: '20.000' },
  ] }, '7707430870113', ['a']);

  assert.deepEqual(result.confirmedIds, ['a']);
  assert.equal(result.pendingUpdates.length, 0);
  assert.equal(result.missingIds.length, 0);
});
