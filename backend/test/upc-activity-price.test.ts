import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { prepareActivityPriceUpdates } from '../src/file-integrations/upc-activity-price.util';

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
