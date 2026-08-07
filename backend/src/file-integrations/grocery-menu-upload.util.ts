import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
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
  return {
    referenceId: String(body.data?.taskID ?? body.data?.taskId ?? body.requestId ?? 'accepted'),
    successfulItemIds: batch.items.map(item => String(item.app_item_id)),
    failedItems: [],
    acceptedCount: batch.items.length,
  };
}
