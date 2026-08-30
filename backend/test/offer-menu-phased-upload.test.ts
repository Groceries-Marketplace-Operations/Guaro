import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  checkGroceryUploadTaskOnce,
  GroceryBatchSubmissionRejectedError,
  resolveGroceryBatchSubmission,
  submitGroceryBatch,
} from '../src/file-integrations/grocery-menu-upload.util';
import { FlatGroceryUpload } from '../src/file-integrations/grocery-destination-menu.util';
import { downloadMenu } from '../src/integrations/auto-turn-off-api.util';

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

test('an explicit uploadGrocery rejection is distinguishable from ambiguous transport failure and is not retried', async t => {
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ errno: 20101, errmsg: 'invalid category hierarchy', data: {} }), { status: 200 });
  };

  await assert.rejects(
    () => submitGroceryBatch('token', batch, 'uploadGrocery', 0),
    (error: Error) => error instanceof GroceryBatchSubmissionRejectedError
      && /invalid category hierarchy/.test(error.message),
  );
  assert.equal(calls, 1);
});

test('a returned taskID remains authoritative even when the response envelope is contradictory', async t => {
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      errno: 20101,
      errmsg: 'contradictory response',
      data: { taskID: 'task-authoritative-1' },
    }), { status: 500 });
  };

  const submission = await submitGroceryBatch('token', batch, 'uploadGrocery', 0);

  assert.deepEqual(submission, { referenceId: 'task-authoritative-1' });
  assert.equal(calls, 1);
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

test('DiDi task-info frequency errors remain pending instead of failing the store', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(JSON.stringify({
    errno: 10005,
    errmsg: 'The calling frequency exceeds the setting: window: 5s, limit: 1',
    data: {},
  }), { status: 200 });

  const result = await checkGroceryUploadTaskOnce('token', 'task-rate-limited');

  assert.equal(result.terminal, false);
  assert.equal(result.rateLimited, true);
  assert.equal(result.status, undefined);
  assert.deepEqual(result.failedItems, []);
});

test('menu export resumes an existing task and reports its progress without creating another export', async t => {
  const originalFetch = global.fetch;
  const calls: string[] = [];
  const progress: string[] = [];
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (url.includes('getGroceryMenuTaskInfo')) {
      return new Response(JSON.stringify({
        errno: 0,
        errmsg: 'ok',
        data: {
          status: 1,
          operationList: [{ operationType: 'menuExportDone', successList: ['https://menu.didiglobal.com/export.json'] }],
        },
      }), { status: 200 });
    }
    if (url === 'https://menu.didiglobal.com/export.json') {
      return new Response(JSON.stringify({ items: [{ upc: '7501', app_item_id: 'item-1' }] }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await downloadMenu('token', async () => undefined, undefined, {
    existingTaskId: 'export-task-1',
    onProgress: async value => { progress.push(value.phase); },
  });

  assert.equal(result.taskId, 'export-task-1');
  assert.equal(result.items.length, 1);
  assert.equal(calls.filter(url => /\/v3\/item\/item\/menu$/.test(url)).length, 0);
  assert.deepEqual(progress, ['waiting', 'downloading']);
});
