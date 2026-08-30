import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import { FlatGroceryUpload } from './grocery-destination-menu.util';
import { withGroceryTaskStatusRateLimit } from './grocery-task-status-limiter';
export { GROCERY_TASK_STATUS_MIN_INTERVAL_MS } from './grocery-task-status-limiter';

export const GROCERY_UPLOAD_ENDPOINTS = ['uploadGrocery', 'updateItemsync'] as const;
export type GroceryUploadEndpoint = typeof GROCERY_UPLOAD_ENDPOINTS[number];

export interface GroceryItemFailure {
  appItemId: string;
  reason: string;
}

export interface GroceryBatchUploadResult {
  referenceId: string;
  successfulItemIds: string[];
  failedItems: GroceryItemFailure[];
  acceptedCount: number;
}

export interface GroceryBatchSubmission {
  referenceId: string;
}

export interface GroceryUploadTaskCheckResult {
  status: number | undefined;
  failedItems: GroceryItemFailure[];
  authToken: string;
  terminal: boolean;
  rateLimited: boolean;
}

export class GroceryUploadPendingError extends Error {
  constructor(
    readonly taskId: string,
    readonly lastStatus: number | undefined,
    readonly polls: number,
    readonly failedItems: GroceryItemFailure[],
    timeoutMs: number,
  ) {
    super(
      `Grocery upload task ${taskId} is still processing after ${Math.round(timeoutMs / 60_000)} minutes; `
      + `last status=${lastStatus ?? 'unknown'}; polls=${polls}`,
    );
    this.name = 'GroceryUploadPendingError';
  }
}

function taskIssues(operations: unknown): GroceryItemFailure[] {
  if (!Array.isArray(operations)) return [];
  const issues = operations.flatMap((operation: Record<string, unknown>) => [
    ...(Array.isArray(operation.warningList) ? operation.warningList : []),
    ...(Array.isArray(operation.failedList) ? operation.failedList : []),
  ]).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const issue = entry as Record<string, unknown>;
    const appItemId = issue.appItemID ?? issue.app_item_id ?? issue.ext_id;
    const reason = issue.message ?? issue.msg ?? issue.reason;
    if (!appItemId && !reason && issue.operationType) return [];
    return [{
      appItemId: String(appItemId ?? 'unknown'),
      reason: String(reason ?? JSON.stringify(issue)),
    }];
  });
  return [...new Map(issues.map(issue => [`${issue.appItemId}:${issue.reason}`, issue])).values()];
}

export async function checkGroceryUploadTaskOnce(
  authToken: string,
  taskId: string,
  refreshAuthToken?: () => Promise<string>,
  rateLimitKey = 'global',
): Promise<GroceryUploadTaskCheckResult> {
  return withGroceryTaskStatusRateLimit(async () => {
    const endpoint = 'POST /v3/item/item/getGroceryMenuTaskInfo';
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v3/item/item/getGroceryMenuTaskInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, task_id: taskId }),
    });
    const rawBody = await response.text();
    const errno = Number(rawBody.match(/"errno"\s*:\s*(-?\d+)/)?.[1]);
    const errmsg = rawBody.match(/"errmsg"\s*:\s*"([^"]*)"/)?.[1] ?? '';
    if (errno === 10005 || /task\s*not found/i.test(rawBody)) {
      return {
        status: undefined,
        failedItems: [],
        authToken,
        terminal: false,
        rateLimited: /frequency|limit|window/i.test(errmsg),
      };
    }
    if (errno === 10102 && refreshAuthToken) {
      return {
        status: undefined,
        failedItems: [],
        authToken: await refreshAuthToken(),
        terminal: false,
        rateLimited: false,
      };
    }
    if (!response.ok || errno !== 0) {
      const body = parseJsonKeepingIds(rawBody) as Record<string, any>;
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
    // Pending responses can contain a very large operationList. Avoid parsing
    // it until DiDi reports a terminal status.
    const statusMatch = rawBody.match(/"data"\s*:\s*\{[\s\S]{0,4096}?"status"\s*:\s*(\d+)/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    if (status === 0 || status === 3 || status === 4 || status === undefined) {
      return { status, failedItems: [], authToken, terminal: false, rateLimited: false };
    }
    const body = parseJsonKeepingIds(rawBody) as Record<string, any>;
    const failedItems = taskIssues(body.data?.operationList);
    if (status === 1 || status === 2 || status === 5) {
      return { status, failedItems, authToken, terminal: true, rateLimited: false };
    }
    throw new Error(`${endpoint} returned unsupported task status ${status}`);
  }, rateLimitKey);
}

export async function waitForGroceryUploadTask(
  authToken: string,
  taskId: string,
  ensureActive: () => Promise<void> = async () => undefined,
  refreshAuthToken?: () => Promise<string>,
  timeoutMs = 30 * 60_000,
  rateLimitKey = 'global',
): Promise<{ status: number; failedItems: GroceryItemFailure[] }> {
  const endpoint = 'POST /v3/item/item/getGroceryMenuTaskInfo';
  const startedAt = Date.now();
  let attempts = 0;
  let lastStatus: number | undefined;
  let pollingToken = authToken;
  while (Date.now() - startedAt < timeoutMs) {
    await ensureActive();
    if (attempts > 0) await sleep(10_000);
    attempts += 1;
    const check = await checkGroceryUploadTaskOnce(pollingToken, taskId, refreshAuthToken, rateLimitKey);
    pollingToken = check.authToken;
    if (check.status !== undefined) lastStatus = check.status;
    if (!check.terminal) continue;
    if (check.status === 1 || check.status === 5) return { status: check.status, failedItems: check.failedItems };
    if (check.status === 2) {
      const detail = check.failedItems.slice(0, 10).map(item => `${item.appItemId}: ${item.reason}`).join('; ');
      throw new Error(`${endpoint} reported failed upload task ${taskId}${detail ? `: ${detail}` : ''}`);
    }
  }
  throw new GroceryUploadPendingError(taskId, lastStatus, attempts, [], timeoutMs);
}

export function buildGroceryUploadRequest(
  authToken: string,
  batch: FlatGroceryUpload,
  uploadEndpoint: string,
  mergePolicy: number,
) {
  if (!GROCERY_UPLOAD_ENDPOINTS.includes(uploadEndpoint as GroceryUploadEndpoint)) {
    throw new Error(`Unsupported grocery upload endpoint: ${uploadEndpoint}`);
  }
  if (uploadEndpoint === 'updateItemsync') {
    return {
      endpoint: 'POST /v3/item/item/updateItemsync',
      url: `${DIDI_BASE}/v3/item/item/updateItemsync`,
      payload: { auth_token: authToken, item_list: batch.items },
    };
  }
  const payload: Record<string, unknown> = {
    auth_token: authToken,
    menus: batch.menus,
    categories: batch.categories,
    items: batch.items,
    merge_policy: mergePolicy,
  };
  if (batch.modifierGroups?.length) payload.modifier_groups = batch.modifierGroups;
  return {
    endpoint: 'POST /v3/item/item/uploadGrocery',
    url: `${DIDI_BASE}/v3/item/item/uploadGrocery`,
    payload,
  };
}

export async function submitGroceryBatch(
  authToken: string,
  batch: FlatGroceryUpload,
  uploadEndpoint: string,
  mergePolicy: number,
): Promise<GroceryBatchSubmission | GroceryBatchUploadResult> {
  const request = buildGroceryUploadRequest(authToken, batch, uploadEndpoint, mergePolicy);
  const response = await fetchWithEndpointContext(request.endpoint, request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request.payload),
  });
  const body = parseJsonKeepingIds(await response.text()) as Record<string, any>;
  if (!response.ok || body.errno !== 0) {
    throw new Error(`${request.endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
  }
  if (uploadEndpoint === 'updateItemsync') return parseUpdateItemSyncResult(body, batch.items.length);
  const referenceId = String(body.data?.taskID ?? body.data?.taskId ?? '');
  if (!referenceId) throw new Error(`${request.endpoint} did not return a taskID`);
  return { referenceId };
}

export async function resolveGroceryBatchSubmission(
  authToken: string,
  referenceId: string,
  itemCount: number,
  ensureActive: () => Promise<void> = async () => undefined,
  refreshAuthToken?: () => Promise<string>,
  timeoutMs?: number,
  rateLimitKey = 'global',
): Promise<GroceryBatchUploadResult> {
  const completed = await waitForGroceryUploadTask(
    authToken,
    referenceId,
    ensureActive,
    refreshAuthToken,
    timeoutMs,
    rateLimitKey,
  );
  return {
    referenceId,
    successfulItemIds: [],
    failedItems: completed.failedItems,
    acceptedCount: Math.max(0, itemCount - completed.failedItems.length),
  };
}

export function parseUpdateItemSyncResult(body: Record<string, any>, itemCount: number): GroceryBatchUploadResult {
  const successfulItemIds = Array.isArray(body.data?.success)
    ? body.data.success.map((value: unknown) => String(value))
    : [];
  const failedItems: GroceryItemFailure[] = Array.isArray(body.data?.failed)
    ? body.data.failed.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      return Object.entries(entry as Record<string, unknown>).map(([appItemId, reason]) => ({
        appItemId,
        reason: String(reason),
      }));
    })
    : [];
  const acceptedCount = successfulItemIds.length
    || (failedItems.length ? Math.max(0, itemCount - failedItems.length) : itemCount);
  return {
    referenceId: String(body.requestId ?? 'accepted'),
    successfulItemIds,
    failedItems,
    acceptedCount,
  };
}

export async function uploadGroceryBatch(
  authToken: string,
  batch: FlatGroceryUpload,
  uploadEndpoint: string,
  mergePolicy: number,
  ensureActive: () => Promise<void> = async () => undefined,
  refreshAuthToken?: () => Promise<string>,
  timeoutMs?: number,
  rateLimitKey = 'global',
): Promise<GroceryBatchUploadResult> {
  const submission = await submitGroceryBatch(authToken, batch, uploadEndpoint, mergePolicy);
  if ('acceptedCount' in submission) return submission;
  const completed = await resolveGroceryBatchSubmission(
    authToken,
    submission.referenceId,
    batch.items.length,
    ensureActive,
    refreshAuthToken,
    timeoutMs,
    rateLimitKey,
  );
  const failedItemIds = new Set(completed.failedItems.map(item => item.appItemId));
  return {
    ...completed,
    successfulItemIds: batch.items.map(item => String(item.app_item_id)).filter(id => !failedItemIds.has(id)),
  };
}
