import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';

export type StockEndpoint = 'setStock' | 'setstockSync';

export interface FailedItem {
  appItemId?: string;
  upc?: string;
  reason: string;
}

export interface SuccessfulItem {
  appItemId: string;
  upc?: string;
  name?: string;
  confirmation?: 'accepted' | 'confirmed';
}

export interface ShopResult {
  shopId: string;
  appShopId: string;
  success: boolean;
  endpoint: StockEndpoint;
  itemsSucceeded: number;
  itemsFailed: number;
  taskId?: string;
  menuTaskId?: string;
  menuSource?: 'catalog' | 'download';
  requestedUpcs?: number;
  matchedUpcs?: number;
  missingUpcs?: string[];
  successfulItems?: SuccessfulItem[];
  failedItems?: FailedItem[];
  error?: string;
}

export class AutoTurnOffCancelledError extends Error {
  constructor() {
    super('Execution was cancelled');
    this.name = 'AutoTurnOffCancelledError';
  }
}

export function isMenuTaskPending(body: Record<string, unknown>) {
  return body.errno === 10005 || /task\s*\([^)]*\)\s*not found|task not found/i.test(String(body.errmsg ?? ''));
}

export async function downloadMenu(
  authToken: string,
  ensureActive: () => Promise<void>,
  refreshAuthToken?: () => Promise<string>,
): Promise<{
  taskId: string;
  items: Array<Record<string, unknown>>;
  /** Exact JSON document downloaded from DiDi, kept for complete exports. */
  rawJson: string;
  elapsedMs: number;
  pollAttempts: number;
}> {
  const startedAt = Date.now();
  const timeoutMs = 20 * 60_000;
  const pollIntervalMs = 6000;
  await ensureActive();
  const createEndpoint = 'POST /v3/item/item/menu';
  const createResponse = await fetchWithEndpointContext(createEndpoint, `${DIDI_BASE}/v3/item/item/menu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken }),
  });
  const createBody = parseJsonKeepingIds(await createResponse.text());
  if (!createResponse.ok || createBody.errno !== 0) {
    throw new Error(`${createEndpoint} failed: ${createBody.errmsg ?? `HTTP ${createResponse.status}`}`);
  }
  const taskId = String(createBody.data?.taskID ?? createBody.data?.taskId ?? '');
  if (!taskId) throw new Error('Menu export did not return a taskID');

  let downloadUrl = '';
  let pollAttempts = 0;
  let lastStatus: number | undefined;
  let pollingToken = authToken;
  while (Date.now() - startedAt < timeoutMs) {
    await ensureActive();
    if (pollAttempts > 0) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
      await ensureActive();
    }
    pollAttempts += 1;
    const taskEndpoint = 'POST /v3/item/item/getGroceryMenuTaskInfo';
    const taskResponse = await fetchWithEndpointContext(
      taskEndpoint,
      `${DIDI_BASE}/v3/item/item/getGroceryMenuTaskInfo`,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: pollingToken, task_id: taskId }),
      },
    );
    const taskBody = parseJsonKeepingIds(await taskResponse.text());
    if (isMenuTaskPending(taskBody)) continue;
    if (taskBody.errno === 10102 && refreshAuthToken) {
      pollingToken = await refreshAuthToken();
      continue;
    }
    if (!taskResponse.ok || taskBody.errno !== 0) {
      throw new Error(
        `${taskEndpoint} failed: ${taskBody.errmsg ?? `HTTP ${taskResponse.status}`}`
        + `${taskBody.errno !== undefined ? ` (errno=${taskBody.errno})` : ''}`,
      );
    }

    const status = Number(taskBody.data?.status);
    lastStatus = status;
    const operations = Array.isArray(taskBody.data?.operationList) ? taskBody.data.operationList : [];
    const completed = operations.find((operation: Record<string, unknown>) => operation.operationType === 'menuExportDone');
    const successList = completed && Array.isArray(completed.successList) ? completed.successList : [];
    if ((status === 1 || status === 5) && typeof successList[0] === 'string') {
      downloadUrl = successList[0];
      break;
    }
    if (status === 2) {
      const detail = operations
        .flatMap((operation: Record<string, unknown>) => Array.isArray(operation.failedList) ? operation.failedList : [])
        .slice(0, 5)
        .map((failure: unknown) => typeof failure === 'string' ? failure : JSON.stringify(failure))
        .join('; ');
      throw new Error(
        `${taskEndpoint} reported a failed menu export${detail ? `: ${detail}` : `: ${taskBody.data?.message ?? 'DiDi returned failed status'}`}`,
      );
    }
  }
  if (!downloadUrl) {
    const statusLabel: Record<number, string> = {
      0: 'waiting',
      1: 'success',
      2: 'failed',
      3: 'waitRetry',
      4: 'running',
      5: 'partial success',
    };
    const lastStatusText = lastStatus === undefined
      ? 'unknown'
      : `${statusLabel[lastStatus] ?? 'unknown'} (${lastStatus})`;
    throw new Error(
      `Menu export task ${taskId} timed out after 20 minutes; `
      + `last status: ${lastStatusText}; polls: ${pollAttempts}`,
    );
  }

  await ensureActive();
  const url = new URL(downloadUrl);
  if (!['http:', 'https:'].includes(url.protocol)
    || (url.hostname !== 'didiglobal.com' && !url.hostname.endsWith('.didiglobal.com'))) {
    throw new Error(`Menu export returned an untrusted download host: ${url.hostname}`);
  }
  const downloadEndpoint = `GET menu download (${url.hostname})`;
  const menuResponse = await fetchWithEndpointContext(downloadEndpoint, url);
  if (!menuResponse.ok) throw new Error(`${downloadEndpoint} failed: HTTP ${menuResponse.status}`);
  const contentLength = Number(menuResponse.headers.get('content-length') ?? 0);
  if (contentLength > 50 * 1024 * 1024) throw new Error('Menu JSON exceeds the 50 MB safety limit');
  const rawJson = await menuResponse.text();
  const menu = parseJsonKeepingIds(rawJson);
  if (!Array.isArray(menu.items)) throw new Error('Exported menu JSON does not contain an items array');
  return {
    taskId,
    items: menu.items as Array<Record<string, unknown>>,
    rawJson,
    elapsedMs: Date.now() - startedAt,
    pollAttempts,
  };
}

export function resolveAppItemIds(items: Array<Record<string, unknown>>, requestedUpcs: string[]) {
  const requested = new Set(requestedUpcs.map(upc => upc.trim()));
  const matches = new Map<string, Set<string>>();
  for (const item of items) {
    const upc = item.upc === undefined || item.upc === null ? '' : String(item.upc).trim();
    const appItemId = item.app_item_id === undefined || item.app_item_id === null
      ? ''
      : String(item.app_item_id).trim();
    if (!requested.has(upc) || !appItemId) continue;
    const ids = matches.get(upc) ?? new Set<string>();
    ids.add(appItemId);
    matches.set(upc, ids);
  }
  const missingUpcs = requestedUpcs.filter(upc => !matches.has(upc.trim()));
  return {
    appItemIds: [...new Set([...matches.values()].flatMap(ids => [...ids]))],
    matchedUpcs: requestedUpcs.length - missingUpcs.length,
    missingUpcs,
  };
}

export function buildStockList(appItemIds: string[], stockValue: number) {
  return appItemIds.map(appItemId => ({ app_item_id: appItemId, stock: stockValue }));
}

export async function callStockApi(
  endpoint: StockEndpoint,
  authToken: string,
  stockList: Array<{ app_item_id: string; stock: number }>,
): Promise<Omit<ShopResult, 'shopId' | 'appShopId' | 'endpoint'>> {
  const stockEndpoint = `POST /v1/item/item/${endpoint}`;
  const response = await fetchWithEndpointContext(stockEndpoint, `${DIDI_BASE}/v1/item/item/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken, stock_list: stockList }),
  });
  const body = parseJsonKeepingIds(await response.text());
  if (!response.ok || body.errno !== 0) {
    throw new Error(
      `${stockEndpoint} failed${body.errno !== undefined ? ` (errno=${body.errno})` : ''}: `
      + (body.errmsg || body.message || `HTTP ${response.status}`),
    );
  }

  if (endpoint === 'setStock') {
    const taskId = body.data?.taskID ?? body.data?.taskId ?? body.taskID;
    return {
      success: true,
      itemsSucceeded: stockList.length,
      itemsFailed: 0,
      successfulItems: stockList.map(item => ({ appItemId: item.app_item_id, confirmation: 'accepted' })),
      taskId: taskId ? String(taskId) : undefined,
    };
  }

  const successfulItems = Array.isArray(body.data?.success)
    ? body.data.success.map((item: unknown) => String(item))
    : [];
  const failedItems: FailedItem[] = Array.isArray(body.data?.failed)
    ? body.data.failed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const failure = item as Record<string, unknown>;
      const explicitItemId = failure.ext_id ?? failure.app_item_id;
      if (explicitItemId !== undefined) {
        return [{
          appItemId: String(explicitItemId),
          reason: String(failure.msg ?? failure.reason ?? 'Failed'),
        }];
      }
      return Object.entries(failure).map(([appItemId, reason]) => ({
        appItemId,
        reason: String(reason),
      }));
    })
    : [];

  if (successfulItems.length === 0 && failedItems.length === 0 && stockList.length > 0) {
    throw new Error('setstockSync returned no success or failed item details');
  }

  return {
    success: failedItems.length === 0 && successfulItems.length === stockList.length,
    itemsSucceeded: successfulItems.length,
    itemsFailed: failedItems.length,
    successfulItems: successfulItems.map((appItemId: string) => ({ appItemId, confirmation: 'confirmed' })),
    failedItems: failedItems.length > 0 ? failedItems : undefined,
    error: failedItems.length > 0
      ? `${failedItems.length} item(s) failed: ${failedItems.slice(0, 5).map(item => `${item.appItemId}: ${item.reason}`).join('; ')}`
      : undefined,
  };
}
