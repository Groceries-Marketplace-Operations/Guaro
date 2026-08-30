import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import { withGroceryTaskStatusRateLimit } from '../file-integrations/grocery-task-status-limiter';

export interface MenuDownloadProgress {
  phase: 'requested' | 'waiting' | 'downloading';
  taskId: string;
  pollAttempts: number;
  status?: number;
  rateLimited?: boolean;
}

export interface DownloadMenuOptions {
  existingTaskId?: string;
  rateLimitKey?: string;
  /** null keeps a known task authoritative until DiDi terminalizes it. */
  timeoutMs?: number | null;
  onProgress?: (progress: MenuDownloadProgress) => Promise<void>;
}

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

export interface ShopStockCandidate {
  upc: string;
  appItemId: string;
  name?: string;
}

export interface KnownShopItem extends ShopStockCandidate {
  available: boolean;
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

export class MenuExportTaskFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly detail: string,
  ) {
    super(`Menu export task ${taskId} failed${detail ? `: ${detail}` : ''}`);
    this.name = 'MenuExportTaskFailedError';
  }
}

export function isMenuTaskPending(body: Record<string, unknown>) {
  return body.errno === 10005 || /task\s*\([^)]*\)\s*not found|task not found/i.test(String(body.errmsg ?? ''));
}

export async function downloadMenu(
  authToken: string,
  ensureActive: () => Promise<void>,
  refreshAuthToken?: () => Promise<string>,
  options: DownloadMenuOptions = {},
): Promise<{
  taskId: string;
  items: Array<Record<string, unknown>>;
  /** Exact JSON document downloaded from DiDi, kept for complete exports. */
  rawJson: string;
  elapsedMs: number;
  pollAttempts: number;
}> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs === null ? null : options.timeoutMs ?? 20 * 60_000;
  const pollIntervalMs = 6000;
  await ensureActive();
  let taskId = options.existingTaskId ?? '';
  if (!taskId) {
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
    taskId = String(createBody.data?.taskID ?? createBody.data?.taskId ?? '');
    if (!taskId) throw new Error('Menu export did not return a taskID');
    await options.onProgress?.({ phase: 'requested', taskId, pollAttempts: 0 });
  }

  let downloadUrl = '';
  let pollAttempts = 0;
  let lastStatus: number | undefined;
  let pollingToken = authToken;
  while (timeoutMs === null || Date.now() - startedAt < timeoutMs) {
    await ensureActive();
    if (pollAttempts > 0) {
      const remainingMs = timeoutMs === null ? pollIntervalMs : timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
      await ensureActive();
    }
    pollAttempts += 1;
    const taskEndpoint = 'POST /v3/item/item/getGroceryMenuTaskInfo';
    const taskResponse = await withGroceryTaskStatusRateLimit(() => fetchWithEndpointContext(
      taskEndpoint,
      `${DIDI_BASE}/v3/item/item/getGroceryMenuTaskInfo`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: pollingToken, task_id: taskId }),
      },
    ), options.rateLimitKey);
    const taskBody = parseJsonKeepingIds(await taskResponse.text());
    if (isMenuTaskPending(taskBody)) {
      await options.onProgress?.({
        phase: 'waiting', taskId, pollAttempts,
        rateLimited: /frequency|limit|window/i.test(String(taskBody.errmsg ?? '')),
      });
      continue;
    }
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
    await options.onProgress?.({ phase: 'waiting', taskId, pollAttempts, status });
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
      throw new MenuExportTaskFailedError(
        taskId,
        detail || String(taskBody.data?.message ?? 'DiDi returned failed status'),
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
      `Menu export task ${taskId} timed out after ${Math.round((timeoutMs ?? 0) / 60_000)} minutes; `
      + `last status: ${lastStatusText}; polls: ${pollAttempts}`,
    );
  }

  await ensureActive();
  await options.onProgress?.({ phase: 'downloading', taskId, pollAttempts, status: lastStatus });
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

/**
 * Prefer app_item_id values observed in the exact target shop. For a shop that
 * has not been learned yet, probe the brand-wide candidates once. Candidates
 * that this shop already rejected are not sent again.
 */
export function resolveShopStockCandidates(
  catalogItems: ShopStockCandidate[],
  knownShopItems: KnownShopItem[],
  requestedUpcs: string[],
) {
  const globalByUpc = groupCandidates(catalogItems);
  const shopByUpc = groupCandidates(knownShopItems);
  const candidates: ShopStockCandidate[] = [];
  const missingUpcs: string[] = [];
  const unavailableUpcs: string[] = [];
  const matchedUpcs = new Set<string>();

  for (const requestedUpc of requestedUpcs) {
    const upc = requestedUpc.trim();
    const known = shopByUpc.get(upc) ?? [];
    const available = known.filter(item => item.available);
    if (available.length > 0) {
      candidates.push(...available);
      matchedUpcs.add(upc);
      continue;
    }

    const rejectedIds = new Set(known.filter(item => !item.available).map(item => item.appItemId));
    const untested = (globalByUpc.get(upc) ?? []).filter(item => !rejectedIds.has(item.appItemId));
    if (untested.length > 0) {
      candidates.push(...untested);
      matchedUpcs.add(upc);
    } else if (known.length > 0 || (globalByUpc.get(upc)?.length ?? 0) > 0) {
      unavailableUpcs.push(requestedUpc);
    } else {
      missingUpcs.push(requestedUpc);
    }
  }

  const uniqueCandidates = [...new Map(
    candidates.map(candidate => [candidate.appItemId, candidate]),
  ).values()];
  return {
    candidates: uniqueCandidates,
    matchedUpcs: matchedUpcs.size,
    missingUpcs,
    unavailableUpcs,
  };
}

function groupCandidates<T extends ShopStockCandidate>(items: T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const upc = item.upc.trim();
    const appItemId = item.appItemId.trim();
    if (!upc || !appItemId) continue;
    const current = grouped.get(upc) ?? [];
    if (!current.some(candidate => candidate.appItemId === appItemId)) {
      current.push({ ...item, upc, appItemId });
    }
    grouped.set(upc, current);
  }
  return grouped;
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
