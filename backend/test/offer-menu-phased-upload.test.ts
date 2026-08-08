import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  resolveGroceryBatchSubmission,
  submitGroceryBatch,
} from '../src/file-integrations/grocery-menu-upload.util';
import { FlatGroceryUpload } from '../src/file-integrations/grocery-destination-menu.util';

const batch: FlatGroceryUpload = {
  menus: [{ app_menu_id: 'menu_1', menu_name: 'Menu 1', app_category_ids: ['category_0'] }],
  categories: [{ app_category_id: 'category_0', category_name: 'Despensa', app_item_ids: ['sku-1'] }],
  items: [{ app_item_id: 'sku-1', upc: 'sku-1', price: 100, activity_price: 90, status: 1 }],
  categoryIds: ['category_0'],
};

test('offer menu submission returns the taskID without polling its status', async t => {
  const originalFetch = global.fetch;
  const calls: string[] = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async input => {
    calls.push(String(input));
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok', data: { taskID: 'task-123' } }), { status: 200 });
  };

  const submission = await submitGroceryBatch('token', batch, 'uploadGrocery', 1);

  assert.deepEqual(submission, { referenceId: 'task-123' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v3\/item\/item\/uploadGrocery$/);
});

test('offer menu task status is resolved independently after submission', async t => {
  const originalFetch = global.fetch;
  const calls: string[] = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async input => {
    calls.push(String(input));
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok', data: { status: 1, operationList: [] } }), { status: 200 });
  };

  const result = await resolveGroceryBatchSubmission('token', 'task-123', 1);

  assert.equal(result.referenceId, 'task-123');
  assert.equal(result.acceptedCount, 1);
  assert.deepEqual(result.failedItems, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v3\/item\/item\/getGroceryMenuTaskInfo$/);
});
