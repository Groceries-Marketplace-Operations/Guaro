import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UpcActivityPriceProcessor } from '../src/file-integrations/upc-activity-price.processor';

type Attempt = {
  attempt: number;
  submittedItemIds: string[];
  taskId?: string;
  submissionState: 'prepared' | 'submitting' | 'submitted' | 'terminal' | 'verified' | 'unconfirmed';
  taskStatus?: number;
  polls: number;
  failures: Array<{ appItemId: string; reason: string }>;
  verificationTaskIds: string[];
  confirmedItemIds: string[];
  remainingItemIds: string[];
  missingItemIds: string[];
  error?: string;
};

type Progress = {
  shopId: string;
  appShopId: string;
  phase: 'exporting_menu' | 'matching_upc' | 'submitting_upload' | 'polling_upload' | 'verifying_items' | 'retry_wait';
  message: string;
  matchedItems: number;
  expectedChanges: number;
  exportTaskIds: string[];
  verificationTaskIds: string[];
  uploadTaskIds: string[];
  uploadAttempts: Attempt[];
  expectedItemIds: string[];
  currentTaskId?: string;
  currentTaskStatus?: number;
  currentTaskPolls?: number;
};

type LifecycleResult = {
  confirmedItemIds: string[];
  remainingItemIds: string[];
  missingItemIds: string[];
  lastTaskStatus?: number;
};

type Harness = {
  runUploadLifecycle(input: {
    executionId: string;
    applicationId: string;
    targetUpc: string;
    expectedItemIds: string[];
    latestMenu?: Record<string, unknown>;
    freshToken: () => Promise<string>;
    progress: Progress;
    persist: () => Promise<void>;
  }): Promise<LifecycleResult>;
  pollUploadTask: (
    authToken: string,
    taskId: string,
    refreshAuthToken: () => Promise<string>,
    ensureActive: () => Promise<void>,
    rateLimitKey: string,
    onProgress: (value: { status?: number; polls: number; rateLimited: boolean }) => Promise<void>,
  ) => Promise<{ status: number; failedItems: Array<{ appItemId: string; reason: string }>; polls: number }>;
  downloadMenuWithRetries: (
    getToken: () => Promise<string>,
    ensureActive: () => Promise<void>,
    rateLimitKey: string,
    onProgress: (value: {
      exportAttempt: number;
      progress: {
        taskId: string;
        status?: number;
        pollAttempts: number;
        phase: 'requested' | 'polling' | 'downloading';
        rateLimited: boolean;
      };
    }) => Promise<void>,
    existingTaskId?: string,
  ) => Promise<{ rawJson: string; taskId: string }>;
  ensureCanSubmit: (executionId: string) => Promise<void>;
  ensureMonitorable: (executionId: string) => Promise<void>;
  isCancellationRequested: (executionId: string) => Promise<boolean>;
  assertRemoteWriteGate: (dryRun: boolean) => void;
};

const TARGET_UPC = '7707430870113';

function harness() {
  const processor = new UpcActivityPriceProcessor({} as never, {} as never, {} as never);
  const value = processor as unknown as Harness;
  value.ensureCanSubmit = async () => undefined;
  value.ensureMonitorable = async () => undefined;
  value.isCancellationRequested = async () => false;
  value.assertRemoteWriteGate = () => undefined;
  return value;
}

function progress(attempt: Attempt): Progress {
  return {
    shopId: 'shop-1',
    appShopId: 'app-shop-1',
    phase: 'polling_upload',
    message: 'recovering',
    matchedItems: 2,
    expectedChanges: attempt.submittedItemIds.length,
    exportTaskIds: ['initial-export'],
    verificationTaskIds: [],
    uploadTaskIds: attempt.taskId ? [attempt.taskId] : [],
    uploadAttempts: [attempt],
    expectedItemIds: [...attempt.submittedItemIds],
  };
}

function attempt(state: Attempt['submissionState'], taskId?: string, ids = ['a']): Attempt {
  return {
    attempt: 1,
    submittedItemIds: ids,
    taskId,
    submissionState: state,
    polls: 0,
    failures: [],
    verificationTaskIds: [],
    confirmedItemIds: [],
    remainingItemIds: ids,
    missingItemIds: [],
  };
}

function menu(items: Array<Record<string, unknown>>) {
  return JSON.stringify({
    menus: [{ app_menu_id: 'menu-1', app_category_ids: ['category-1'] }],
    categories: [{ app_category_id: 'category-1', app_item_ids: items.map(item => item.app_item_id) }],
    items,
  });
}

test('restored submitted upload polls the same taskID and never calls uploadGrocery', async t => {
  const processor = harness();
  const restored = progress(attempt('submitted', 'persisted-task-1'));
  const polledTaskIds: string[] = [];
  let uploadCalls = 0;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    uploadCalls += 1;
    throw new Error('No remote POST is expected while recovering a known taskID');
  };
  processor.pollUploadTask = async (_token, taskId) => {
    polledTaskIds.push(taskId);
    return { status: 1, failedItems: [], polls: 2 };
  };
  processor.downloadMenuWithRetries = async () => ({
    taskId: 'verification-export-1',
    rawJson: menu([{ app_item_id: 'a', upc: TARGET_UPC, price: 20, activity_price: 20 }]),
  });

  const result = await processor.runUploadLifecycle({
    executionId: 'execution-1',
    applicationId: 'application-1',
    targetUpc: TARGET_UPC,
    expectedItemIds: ['a'],
    freshToken: async () => 'token',
    progress: restored,
    persist: async () => undefined,
  });

  assert.deepEqual(polledTaskIds, ['persisted-task-1']);
  assert.equal(uploadCalls, 0);
  assert.equal(restored.uploadAttempts.length, 1);
  assert.equal(restored.uploadAttempts[0].taskId, 'persisted-task-1');
  assert.equal(restored.uploadAttempts[0].submissionState, 'verified');
  assert.deepEqual(result.confirmedItemIds, ['a']);
  assert.deepEqual(result.remainingItemIds, []);
});

test('submitting or unconfirmed checkpoint without taskID blocks automatic resubmission', async t => {
  const originalFetch = global.fetch;
  let uploadCalls = 0;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    uploadCalls += 1;
    throw new Error('ambiguous checkpoints must not reach uploadGrocery');
  };

  for (const state of ['submitting', 'unconfirmed'] as const) {
    const processor = harness();
    await assert.rejects(
      processor.runUploadLifecycle({
        executionId: `execution-${state}`,
        applicationId: 'application-1',
        targetUpc: TARGET_UPC,
        expectedItemIds: ['a'],
        freshToken: async () => 'token',
        progress: progress(attempt(state)),
        persist: async () => undefined,
      }),
      /without a persisted taskID|unknown acceptance|automatic resubmission is blocked/i,
    );
  }

  assert.equal(uploadCalls, 0);
});

test('terminal failures retry only remaining item IDs and stop at three attempts', async t => {
  const processor = harness();
  const restored = progress(attempt('submitted', 'persisted-task-1', ['a', 'b']));
  const polledTaskIds: string[] = [];
  const uploadBodies: Array<Record<string, unknown>> = [];
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
  global.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  global.fetch = async (_input, init) => {
    uploadBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      errno: 0,
      errmsg: 'ok',
      data: { taskID: `retry-task-${uploadBodies.length + 1}` },
    }), { status: 200 });
  };
  processor.pollUploadTask = async (_token, taskId) => {
    polledTaskIds.push(taskId);
    return {
      status: 2,
      failedItems: [{ appItemId: 'b', reason: 'temporary rejection' }],
      polls: 1,
    };
  };
  processor.downloadMenuWithRetries = async () => ({
    taskId: `verification-export-${restored.verificationTaskIds.length + 1}`,
    rawJson: menu([
      { app_item_id: 'a', upc: TARGET_UPC, price: 20, activity_price: 20 },
      { app_item_id: 'b', upc: TARGET_UPC, price: 30, activity_price: 10 },
      { app_item_id: 'new-target', upc: TARGET_UPC, price: 40, activity_price: 5 },
    ]),
  });

  const result = await processor.runUploadLifecycle({
    executionId: 'execution-retry',
    applicationId: 'application-1',
    targetUpc: TARGET_UPC,
    expectedItemIds: ['a', 'b'],
    freshToken: async () => 'token',
    progress: restored,
    persist: async () => undefined,
  });

  assert.deepEqual(polledTaskIds, ['persisted-task-1', 'retry-task-2', 'retry-task-3']);
  assert.equal(uploadBodies.length, 2);
  assert.equal(restored.uploadAttempts.length, 3);
  assert.deepEqual(restored.uploadAttempts.map(value => value.submittedItemIds), [
    ['a', 'b'],
    ['b'],
    ['b'],
  ]);
  for (const body of uploadBodies) {
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.find(item => item.app_item_id === 'b')?.activity_price, 30);
    assert.equal(items.find(item => item.app_item_id === 'new-target')?.activity_price, 5);
  }
  assert.deepEqual(result.confirmedItemIds, ['a']);
  assert.deepEqual(result.remainingItemIds, ['b']);
  assert.equal(result.lastTaskStatus, 2);
});

test('cancellation after an accepted task waits for terminal status and does not retry', async t => {
  const processor = harness();
  const restored = progress(attempt('submitted', 'accepted-before-cancel'));
  const polledTaskIds: string[] = [];
  let uploadCalls = 0;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    uploadCalls += 1;
    throw new Error('cancellation must not submit a replacement task');
  };
  processor.isCancellationRequested = async () => true;
  processor.pollUploadTask = async (_token, taskId) => {
    polledTaskIds.push(taskId);
    return {
      status: 2,
      failedItems: [{ appItemId: 'a', reason: 'terminal failure after cancellation' }],
      polls: 4,
    };
  };
  processor.downloadMenuWithRetries = async () => {
    throw new Error('cancellation should finish after the accepted task terminalizes');
  };

  const result = await processor.runUploadLifecycle({
    executionId: 'execution-cancelled',
    applicationId: 'application-1',
    targetUpc: TARGET_UPC,
    expectedItemIds: ['a'],
    freshToken: async () => 'token',
    progress: restored,
    persist: async () => undefined,
  });

  assert.deepEqual(polledTaskIds, ['accepted-before-cancel']);
  assert.equal(uploadCalls, 0);
  assert.equal(restored.uploadAttempts.length, 1);
  assert.equal(restored.uploadAttempts[0].submissionState, 'terminal');
  assert.equal(restored.uploadAttempts[0].taskStatus, 2);
  assert.equal(restored.uploadAttempts[0].polls, 4);
  assert.deepEqual(result.remainingItemIds, ['a']);
  assert.equal(result.lastTaskStatus, 2);
});
