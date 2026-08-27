import { createHash } from 'crypto';

export const DIDI_BASE = 'https://openapi.didi-food.com';

// ── Batching / throttle constants ─────────────────────────────────────────────
export const BATCH_SIZE          = 20;    // shops per batch
export const COOLDOWN_PAGE_MS    = 500;   // between pagination calls
export const COOLDOWN_BATCH_MS   = 1500;  // between shop batches
export const COOLDOWN_RETRY_MS   = 2000;  // before retry on transient error
export const COOLDOWN_SHOPLIST_MS = 20000; // between shop list pagination pages (DiDi rate limit)

// ── Primitives ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Wrap fetch transport errors with a safe method/path label.
 * The real URL may contain app_secret, auth_token or signed query parameters,
 * so it must never be copied into logs or execution results.
 */
export async function fetchWithEndpointContext(
  endpoint: string,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    const requestError = error as Error & {
      cause?: { code?: string; message?: string };
    };
    const cause = requestError.cause;
    const causeDetail = [cause?.code, cause?.message].filter(Boolean).join(': ');
    const wrapped = new Error(
      `${endpoint} failed: ${requestError.message}${causeDetail ? ` (${causeDetail})` : ''}`,
    ) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }
}

/** True if the ID is a raw DiDi shop_id (starts with "57", exactly 19 digits). */
export function isRawShopId(id: string): boolean {
  const s = id.toString().trim();
  return s.startsWith('57') && s.length === 19;
}

/**
 * MD5 signature for DiDi Food API outgoing requests.
 * Sorts params alphabetically, joins as key=value&..., appends appSecret.
 */
export function generateSignature(
  params: Record<string, string | number>,
  appSecret: string,
): string {
  const sorted = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return createHash('md5').update(sorted + appSecret).digest('hex');
}

/**
 * JSON.parse that preserves large integer IDs as strings.
 * DiDi returns 64-bit integers (e.g. taskID) that lose precision in JS.
 */
export function parseJsonKeepingIds(text: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  // Wrap large integers in ID fields as strings to avoid JS precision loss.
  // Matches: shopId, appId, taskID, menuID, shop_id, app_shop_id, etc.
  const safe = text.replace(/"(\w*[Ii][Dd]\w*)":\s*(\d{10,})/g, '"$1":"$2"');
  return JSON.parse(safe);
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

export function isClosed(schedule: string | null | undefined): boolean {
  return !schedule || schedule.trim().toLowerCase() === 'closed';
}

/**
 * Parse "HH:MM-HH:MM" or "HH:MM-HH:MM,HH:MM-HH:MM" into minute-offsets.
 * Returns array of {begin, end} in minutes from midnight.
 */
export function parseScheduleString(s: string): { begin: number; end: number }[] {
  const value = s.trim();
  if (!value) throw new Error('Schedule is empty');

  return value.split(',').map(rawRange => {
    const range = rawRange.trim();
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range);
    if (!match) throw new Error(`Invalid schedule "${range}". Use HH:MM-HH:MM`);

    const [, shRaw, smRaw, ehRaw, emRaw] = match;
    const sh = Number(shRaw);
    const sm = Number(smRaw);
    const eh = Number(ehRaw);
    const em = Number(emRaw);
    const validStart = sh >= 0 && sh <= 23 && sm >= 0 && sm <= 59;
    const validEnd = eh >= 0 && eh <= 24 && em >= 0 && em <= 59 && (eh !== 24 || em === 0);
    if (!validStart || !validEnd) throw new Error(`Invalid time in schedule "${range}"`);

    return { begin: sh * 60 + sm, end: eh * 60 + em };
  });
}

/** Convert minutes-from-midnight to "HH:MM" string. */
export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Normalise a JS Date or date string to "YYYY-MM-DD". */
export function normalizeDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date "${String(d)}"`);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Two-step DiDi Food auth: refresh token → access token, per shop.
 * Both calls are GET with query params.
 */
export async function getAuthToken(
  appId: string,
  appSecret: string,
  appShopId: string,
  signal?: AbortSignal,
): Promise<string> {
  const timestamp = String(Math.floor(Date.now() / 1000));

  // Step 1 — get refresh token
  const refreshParams: Record<string, string> = { app_id: appId, app_secret: appSecret, app_shop_id: appShopId, timestamp };
  refreshParams.sign = generateSignature(refreshParams, appSecret);
  const refreshUrl = new URL(`${DIDI_BASE}/v1/auth/authtoken/refresh`);
  Object.entries(refreshParams).forEach(([k, v]) => refreshUrl.searchParams.set(k, v));

  const refreshEndpoint = 'GET /v1/auth/authtoken/refresh';
  const refreshRes = await fetchWithEndpointContext(refreshEndpoint, refreshUrl, { signal });
  const refreshBody = parseJsonKeepingIds(await refreshRes.text());
  if (!refreshRes.ok || refreshBody.errno !== 0) {
    throw new Error(
      `${refreshEndpoint} failed: ${refreshBody.errmsg ?? `HTTP ${refreshRes.status}`} (errno=${refreshBody.errno ?? 'unknown'})`,
    );
  }
  const refreshToken: string = refreshBody.data.refresh_token;

  // Step 2 — get access token
  const getParams: Record<string, string> = { app_id: appId, app_secret: appSecret, app_shop_id: appShopId, refresh_token: refreshToken, timestamp };
  getParams.sign = generateSignature(getParams, appSecret);
  const getUrl = new URL(`${DIDI_BASE}/v1/auth/authtoken/get`);
  Object.entries(getParams).forEach(([k, v]) => getUrl.searchParams.set(k, v));

  const getEndpoint = 'GET /v1/auth/authtoken/get';
  const getRes = await fetchWithEndpointContext(getEndpoint, getUrl, { signal });
  const getBody = parseJsonKeepingIds(await getRes.text());
  if (!getRes.ok || getBody.errno !== 0) {
    throw new Error(
      `${getEndpoint} failed: ${getBody.errmsg ?? `HTTP ${getRes.status}`} (errno=${getBody.errno ?? 'unknown'})`,
    );
  }
  return getBody.data.auth_token as string;
}

// ── Shop list ─────────────────────────────────────────────────────────────────

/**
 * Fetch all shops for an app and return a map of shop_id → app_shop_id.
 * Uses POST /v1/shop/shop/list with pagination (page_size=100).
 * Waits COOLDOWN_SHOPLIST_MS between pages to respect DiDi's rate limit.
 */
export async function fetchShopIdMap(
  appId: string,
  appSecret: string,
  targetShopIds?: readonly string[],
): Promise<Map<string, string>> {
  const pageSize = 100;
  const allShops: { shopId: string; appShopId: string }[] = [];
  const unresolved = targetShopIds ? new Set(targetShopIds) : null;
  let pageNo = 1;

  while (true) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params: Record<string, string | number> = { app_id: appId, page_no: pageNo, page_size: pageSize, timestamp };
    params.sign = generateSignature(params, appSecret);

    const endpoint = 'POST /v1/shop/shop/list';
    const res = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const body = parseJsonKeepingIds(await res.text());
    if (body.errno === 10005) {
      // Rate limit: 1 call per 20 s window — wait and retry this page once
      await sleep(COOLDOWN_SHOPLIST_MS);
      continue;
    }
    if (body.errno !== 0) {
      throw new Error(
        `${endpoint} failed on page ${pageNo}: ${body.errmsg ?? `HTTP ${res.status}`} (errno=${body.errno ?? 'unknown'})`,
      );
    }

    const shops: { shop_id: string; app_shop_id: string }[] = body.data?.shop_list ?? [];
    for (const s of shops) {
      const shopId = String(s.shop_id);
      allShops.push({ shopId, appShopId: String(s.app_shop_id) });
      unresolved?.delete(shopId);
    }

    const total: number = body.data?.total ?? 0;
    if (unresolved?.size === 0 || allShops.length >= total || shops.length < pageSize) break;

    pageNo++;
    await sleep(COOLDOWN_SHOPLIST_MS);
  }

  const map = new Map<string, string>();
  for (const s of allShops) map.set(s.shopId, s.appShopId);
  return map;
}
