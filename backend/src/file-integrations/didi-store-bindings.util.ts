import { createHash } from 'crypto';
import { generateSignature } from '../queue/handlers/didi-food.util';

export const DIDI_BIND_STORE_ENDPOINT = 'POST /v3/auth/authorization/shopBind';
export const DIDI_BIND_STORE_PATH = '/v3/auth/authorization/shopBind';
export const DIDI_UNBIND_STORE_ENDPOINT = 'POST /v1/shop/shop/unbind';
export const DIDI_UNBIND_STORE_PATH = '/v1/shop/shop/unbind';
export const DIDI_LIST_BOUND_STORES_ENDPOINT = 'POST /v1/shop/shop/list';
export const DIDI_LIST_BOUND_STORES_PATH = '/v1/shop/shop/list';
export const DIDI_BIND_MAX_SHOPS = 50;
// Unbind performs a token flow and a mutating request per store. Keep it
// intentionally single-store until operations are durable and resumable.
export const DIDI_UNBIND_MAX_SHOPS = 1;

export interface DidiBindingShopInput {
  shopId?: string;
  appShopId: string;
}

export interface DidiBindingResult {
  shopId?: string;
  appShopId: string;
  status: 'success' | 'failed' | 'unconfirmed';
  reason?: string;
}

export interface DidiBindingSummary {
  requested: number;
  succeeded: number;
  failed: number;
  unconfirmed: number;
  status: 'done' | 'partial' | 'failed' | 'unconfirmed';
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * JSON.stringify cannot safely represent DiDi's 64-bit numeric IDs as numbers.
 * Callers keep IDs as strings in memory; this serializer emits only app_id and
 * shop_id as exact, unquoted decimal JSON literals. app_shop_id remains a string
 * so values such as "001" are not changed.
 */
export function stringifyDidiJsonWithInt64(value: unknown): string {
  const inspect = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(inspect);
      return;
    }
    const object = record(node);
    if (!object) return;
    for (const [key, child] of Object.entries(object)) {
      if (key === 'app_id' || key === 'shop_id') {
        if (typeof child !== 'string' || !/^\d+$/.test(child)) {
          throw new Error(`${key} must be supplied as a decimal string to preserve int64 precision`);
        }
      }
      inspect(child);
    }
  };
  inspect(value);
  return JSON.stringify(value).replace(/"(app_id|shop_id)":"(\d+)"/g, '"$1":$2');
}

export function buildBindRequest(
  appId: string,
  appSecret: string,
  shops: Array<{ shopId: string; appShopId: string }>,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const signatureParams: Record<string, string> = {
    app_id: appId,
    shop_infos: 'Array',
    timestamp,
  };
  const sign = generateSignature(signatureParams, appSecret);
  const payload = {
    app_id: appId,
    timestamp,
    sign,
    shop_infos: shops.map(shop => ({ shop_id: shop.shopId, app_shop_id: shop.appShopId })),
  };
  return { signatureParams, payload, body: stringifyDidiJsonWithInt64(payload) };
}

export function buildListBoundStoresRequest(
  appId: string,
  appSecret: string,
  pageNo: number,
  pageSize: number,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const params: Record<string, string | number> = {
    app_id: appId,
    page_no: pageNo,
    page_size: pageSize,
    timestamp,
  };
  const payload = { ...params, sign: generateSignature(params, appSecret) };
  return { payload, body: stringifyDidiJsonWithInt64(payload) };
}

export function exactConfirmation(action: 'bind' | 'unbind', count: number): string {
  return action === 'bind' ? `VINCULAR ${count} TIENDAS` : `DESVINCULAR ${count} TIENDAS`;
}

export function summarizeBindingResults(results: DidiBindingResult[]): DidiBindingSummary {
  const succeeded = results.filter(result => result.status === 'success').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const unconfirmed = results.filter(result => result.status === 'unconfirmed').length;
  return {
    requested: results.length,
    succeeded,
    failed,
    unconfirmed,
    status: unconfirmed === results.length
      ? 'unconfirmed'
      : succeeded === results.length
        ? 'done'
        : failed === results.length
          ? 'failed'
          : 'partial',
  };
}

export function redactSensitiveText(value: unknown, knownSecrets: string[] = []): string {
  let result = text(value);
  for (const secret of knownSecrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  result = result
    .replace(/((?:auth_token|refresh_token|app_secret|sign)\s*[=:]\s*)[^\s,;}&]+/gi, '$1[REDACTED]')
    .replace(/("(?:auth_token|refresh_token|app_secret|sign)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
  return result.slice(0, 1500);
}

export function redactDidiValue(value: unknown, knownSecrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(entry => redactDidiValue(entry, knownSecrets));
  const object = record(value);
  if (object) {
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [
      key,
      /^(?:auth_token|refresh_token|app_secret|sign)$/i.test(key)
        ? '[REDACTED]'
        : redactDidiValue(entry, knownSecrets),
    ]));
  }
  return typeof value === 'string' ? redactSensitiveText(value, knownSecrets) : value;
}

function bindResponseData(body: unknown): JsonRecord {
  const outer = record(body) ?? {};
  const data = record(outer.data);
  return data && (Array.isArray(data.success_list) || Array.isArray(data.failure_list)) ? data : outer;
}

function didiErrno(body: JsonRecord): number | null {
  const value = body.errno;
  const parsed = typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isExplicitBindResponse(body: unknown): boolean {
  const outer = record(body);
  if (!outer) return false;
  const errno = didiErrno(outer);
  if (errno !== null && errno !== 0) return true;
  const data = bindResponseData(body);
  return Array.isArray(data.success_list) && Array.isArray(data.failure_list);
}

function bindEntryKey(entry: JsonRecord): string {
  return `${text(entry.shop_id)}\u0000${text(entry.app_shop_id)}`;
}

export function normalizeBindResults(
  requested: Array<{ shopId: string; appShopId: string }>,
  body: unknown,
): DidiBindingResult[] {
  const outer = record(body) ?? {};
  const errno = didiErrno(outer);
  if (errno !== null && errno !== 0) {
    const reason = redactSensitiveText(outer.errmsg || `DiDi errno=${text(outer.errno)}`);
    return requested.map(shop => ({ ...shop, status: 'failed', reason }));
  }

  const data = bindResponseData(body);
  const successes = new Set(
    (Array.isArray(data.success_list) ? data.success_list : [])
      .map(record).filter((entry): entry is JsonRecord => Boolean(entry)).map(bindEntryKey),
  );
  const failures = new Map<string, string>(
    (Array.isArray(data.failure_list) ? data.failure_list : [])
      .map(record).filter((entry): entry is JsonRecord => Boolean(entry))
      .map(entry => [bindEntryKey(entry), redactSensitiveText(entry.reason || 'DiDi rejected the binding')]),
  );

  return requested.map(shop => {
    const key = `${shop.shopId}\u0000${shop.appShopId}`;
    if (successes.has(key) && failures.has(key)) {
      return {
        ...shop,
        status: 'unconfirmed',
        reason: 'DiDi reported conflicting results for this store. Verifica estado antes de reintentar.',
      };
    }
    if (successes.has(key)) return { ...shop, status: 'success' };
    if (!failures.has(key)) {
      return {
        ...shop,
        status: 'unconfirmed',
        reason: 'DiDi did not report a result for this store. Verifica estado antes de reintentar.',
      };
    }
    return {
      ...shop,
      status: 'failed',
      reason: failures.get(key),
    };
  });
}

export function fingerprintAppId(appId: string): string {
  return createHash('sha256').update(appId).digest('hex').slice(0, 12);
}
