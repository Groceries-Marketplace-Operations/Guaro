import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import { FlatGroceryUpload } from './grocery-destination-menu.util';

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

export async function waitForGroceryUploadTask(
  authToken: string,
  taskId: string,
  ensureActive: () => Promise<void> = async () => undefined,
  refreshAuthToken?: () => Promise<string>,
  timeoutMs = 30 * 60_000,
): Promise<{ status: number; failedItems: GroceryItemFailure[] }> {
  const endpoint = 'POST /v3/item/item/getGroceryMenuTaskInfo';
  const startedAt = Date.now();
  let attempts = 0;
  let lastStatus: number | undefined;
  let pollingToken = authToken;
  while (Date.now() - startedAt < timeoutMs) {
    await ensureActive();
    if (attempts > 0) await sleep(6000);
    attempts += 1;
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v3/item/item/getGroceryMenuTaskInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: pollingToken, task_id: taskId }),
    });
    const body = parseJsonKeepingIds(await response.text()) as Record<string, any>;
    if (body.errno === 10005 || /task\s*not found/i.test(String(body.errmsg ?? ''))) continue;
    if (body.errno === 10102 && refreshAuthToken) {
      pollingToken = await refreshAuthToken();
      continue;
    }
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
    const status = Number(body.data?.status);
    lastStatus = status;
    const failedItems = taskIssues(body.data?.operationList);
    if (status === 1 || status === 5) return { status, failedItems };
    if (status === 2) {
      const detail = failedItems.slice(0, 10).map(item => `${item.appItemId}: ${item.reason}`).join('; ');
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
  return {
    endpoint: 'POST /v3/item/item/uploadGrocery',
    url: `${DIDI_BASE}/v3/item/item/uploadGrocery`,
    payload: {
      auth_token: authToken,
      menus: batch.menus,
      categories: batch.categories,
      items: batch.items,
      merge_policy: mergePolicy,
    },
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
): Promise<GroceryBatchUploadResult> {
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
  const completed = await waitForGroceryUploadTask(
    authToken,
    referenceId,
    ensureActive,
    refreshAuthToken,
    timeoutMs,
  );
  const failedItemIds = new Set(completed.failedItems.map(item => item.appItemId));
  return {
    referenceId,
    successfulItemIds: batch.items.map(item => String(item.app_item_id)).filter(id => !failedItemIds.has(id)),
    failedItems: completed.failedItems,
    acceptedCount: Math.max(0, batch.items.length - completed.failedItems.length),
  };
}
