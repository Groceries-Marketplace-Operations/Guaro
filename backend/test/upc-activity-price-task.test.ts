import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UpcActivityPriceProcessor } from '../src/file-integrations/upc-activity-price.processor';

type PollResult = { status: number; failedItems: Array<{ appItemId: string; reason: string }>; polls: number };

type MenuResult = { taskId: string; rawJson: string };

function processorPoller() {
  const processor = new UpcActivityPriceProcessor({} as never, {} as never);
  return processor as unknown as {
    pollUploadTask: (
      authToken: string,
      taskId: string,
      refreshAuthToken: () => Promise<string>,
      ensureActive: () => Promise<void>,
      rateLimitKey: string,
      onProgress: (value: { status?: number; polls: number; rateLimited: boolean }) => Promise<void>,
    ) => Promise<PollResult>;
  };
}

function processorMenuDownloader() {
  const processor = new UpcActivityPriceProcessor({} as never, {} as never);
  return processor as unknown as {
    downloadMenuWithRetries: (
      getToken: () => Promise<string>,
      ensureActive: () => Promise<void>,
      rateLimitKey: string,
      onProgress: (value: { exportAttempt: number; progress: { taskId: string } }) => Promise<void>,
      existingTaskId?: string,
    ) => Promise<MenuResult>;
  };
}

test('polls the same upload taskID through waiting, waitRetry, running, and success', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const statuses = [0, 3, 4, 1];
  const requestTaskIds: string[] = [];
  const progress: Array<number | undefined> = [];
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
  global.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  global.fetch = async (_input, init) => {
    requestTaskIds.push(String(JSON.parse(String(init?.body)).task_id));
    const status = statuses.shift();
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok', data: { status, operationList: [] } }), { status: 200 });
  };

  const result = await processorPoller().pollUploadTask(
    'token',
    'upload-task-123',
    async () => 'refreshed-token',
    async () => undefined,
    'upc-task-sequence-test',
    async value => { progress.push(value.status); },
  );

  assert.equal(result.status, 1);
  assert.equal(result.polls, 4);
  assert.deepEqual(progress, [0, 3, 4, 1]);
  assert.deepEqual(requestTaskIds, Array(4).fill('upload-task-123'));
});

test('returns a terminal failed task so the bounded retry policy can decide the next attempt', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(JSON.stringify({
    errno: 0,
    errmsg: 'ok',
    data: {
      status: 2,
      operationList: [{ failedList: [{ appItemID: 'target-1', message: 'rejected' }] }],
    },
  }), { status: 200 });

  const result = await processorPoller().pollUploadTask(
    'token',
    'upload-task-failed',
    async () => 'refreshed-token',
    async () => undefined,
    'upc-task-failed-test',
    async () => undefined,
  );

  assert.equal(result.status, 2);
  assert.equal(result.polls, 1);
  assert.deepEqual(result.failedItems, [{ appItemId: 'target-1', reason: 'rejected' }]);
});

test('resumes the same accepted menu export taskID after a transient lookup failure', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  let createCalls = 0;
  let lookupCalls = 0;
  const lookupTaskIds: string[] = [];
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
  global.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v3/item/item/menu')) {
      createCalls += 1;
      return new Response(JSON.stringify({ errno: 0, data: { taskID: 'menu-task-accepted' } }), { status: 200 });
    }
    if (url.endsWith('/v3/item/item/getGroceryMenuTaskInfo')) {
      lookupCalls += 1;
      lookupTaskIds.push(String(JSON.parse(String(init?.body)).task_id));
      if (lookupCalls === 1) throw new Error('temporary network failure');
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          status: 1,
          operationList: [{ operationType: 'menuExportDone', successList: ['https://files.didiglobal.com/menu.json'] }],
        },
      }), { status: 200 });
    }
    if (url === 'https://files.didiglobal.com/menu.json') {
      return new Response(JSON.stringify({ menus: [], categories: [], items: [] }), { status: 200 });
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  };

  const result = await processorMenuDownloader().downloadMenuWithRetries(
    async () => 'token',
    async () => undefined,
    'upc-menu-resume-test',
    async () => undefined,
  );

  assert.equal(result.taskId, 'menu-task-accepted');
  assert.equal(createCalls, 1);
  assert.equal(lookupCalls, 2);
  assert.deepEqual(lookupTaskIds, ['menu-task-accepted', 'menu-task-accepted']);
});

test('creates a replacement export only after the previous task terminalizes as failed', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const createdTaskIds = ['menu-task-failed', 'menu-task-replacement'];
  const lookupTaskIds: string[] = [];
  let createCalls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
  global.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v3/item/item/menu')) {
      const taskID = createdTaskIds[createCalls];
      createCalls += 1;
      return new Response(JSON.stringify({ errno: 0, data: { taskID } }), { status: 200 });
    }
    if (url.endsWith('/v3/item/item/getGroceryMenuTaskInfo')) {
      const taskId = String(JSON.parse(String(init?.body)).task_id);
      lookupTaskIds.push(taskId);
      if (taskId === 'menu-task-failed') {
        return new Response(JSON.stringify({ errno: 0, data: { status: 2, operationList: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        errno: 0,
        data: {
          status: 1,
          operationList: [{ operationType: 'menuExportDone', successList: ['https://files.didiglobal.com/menu-replacement.json'] }],
        },
      }), { status: 200 });
    }
    if (url === 'https://files.didiglobal.com/menu-replacement.json') {
      return new Response(JSON.stringify({ menus: [], categories: [], items: [] }), { status: 200 });
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  };

  const result = await processorMenuDownloader().downloadMenuWithRetries(
    async () => 'token',
    async () => undefined,
    'upc-menu-terminal-retry-test',
    async () => undefined,
  );

  assert.equal(result.taskId, 'menu-task-replacement');
  assert.equal(createCalls, 2);
  assert.deepEqual(lookupTaskIds, ['menu-task-failed', 'menu-task-replacement']);
});
