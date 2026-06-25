import { createHash } from 'crypto';

export const DIDI_BASE = 'https://openapi.didi-food.com';

// ── Batching / throttle constants ─────────────────────────────────────────────
export const BATCH_SIZE       = 20;    // shops per batch
export const COOLDOWN_PAGE_MS = 500;   // between pagination calls
export const COOLDOWN_BATCH_MS = 1500; // between shop batches
export const COOLDOWN_RETRY_MS = 2000; // before retry on transient error
const BUFFER_MINUTES = 15;             // buffer added to outermost schedule edges

// ── Primitives ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** True if the ID contains only digits (raw numeric DiDi shop ID). */
export function isRawShopId(id: string): boolean {
  return /^\d+$/.test(id.trim());
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
  return createHash('md5').update(sorted + appSecret).digest('hex').toUpperCase();
}

/**
 * JSON.parse that preserves large integer IDs as strings.
 * DiDi returns 64-bit integers (e.g. taskID) that lose precision in JS.
 */
export function parseJsonKeepingIds(text: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  // Wrap any bare integer value longer than 15 digits in quotes
  const safe = text.replace(/"(\w*[Ii]d\w*)":\s*(\d{10,})/g, '"$1":"$2"');
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
  return s.split(',').map(range => {
    const [startStr, endStr] = range.trim().split('-');
    const [sh, sm] = startStr.split(':').map(Number);
    const [eh, em] = endStr.split(':').map(Number);
    return { begin: sh * 60 + (sm || 0), end: eh * 60 + (em || 0) };
  });
}

/**
 * Expand the outermost edges of a schedule by BUFFER_MINUTES.
 * Only first.begin and last.end are adjusted — split-point edges are untouched.
 */
export function applyBuffer(
  ranges: { begin: number; end: number }[],
  bufferMins = BUFFER_MINUTES,
): { begin: number; end: number }[] {
  if (ranges.length === 0) return ranges;
  const result = ranges.map(r => ({ ...r }));
  result[0].begin = Math.max(0, result[0].begin - bufferMins);
  result[result.length - 1].end = Math.min(24 * 60, result[result.length - 1].end + bufferMins);
  return result;
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
): Promise<string> {
  const timestamp = String(Math.floor(Date.now() / 1000));

  // Step 1 — get refresh token
  const refreshParams: Record<string, string> = { app_id: appId, app_secret: appSecret, app_shop_id: appShopId, timestamp };
  refreshParams.sign = generateSignature(refreshParams, appSecret);
  const refreshUrl = new URL(`${DIDI_BASE}/v1/auth/authtoken/refresh`);
  Object.entries(refreshParams).forEach(([k, v]) => refreshUrl.searchParams.set(k, v));

  const refreshRes = await fetch(refreshUrl.toString());
  const refreshBody = parseJsonKeepingIds(await refreshRes.text());
  if (refreshBody.errno !== 0) {
    throw new Error(`DiDi token refresh failed: ${refreshBody.errmsg} (errno=${refreshBody.errno})`);
  }
  const refreshToken: string = refreshBody.data.refresh_token;

  // Step 2 — get access token
  const getParams: Record<string, string> = { app_id: appId, app_secret: appSecret, app_shop_id: appShopId, refresh_token: refreshToken, timestamp };
  getParams.sign = generateSignature(getParams, appSecret);
  const getUrl = new URL(`${DIDI_BASE}/v1/auth/authtoken/get`);
  Object.entries(getParams).forEach(([k, v]) => getUrl.searchParams.set(k, v));

  const getRes = await fetch(getUrl.toString());
  const getBody = parseJsonKeepingIds(await getRes.text());
  if (getBody.errno !== 0) {
    throw new Error(`DiDi token get failed: ${getBody.errmsg} (errno=${getBody.errno})`);
  }
  return getBody.data.access_token as string;
}
