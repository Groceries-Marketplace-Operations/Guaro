import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Tiendas Neto weekly menu cache + two-hour upload daemon.
 *
 * Live:
 *   $env:DIDI_APP_ID='5764607780881696497'
 *   $env:DIDI_APP_SECRET='<secret>'
 *   node --use-system-ca run-weekly-menu-cache-upload-v5.mjs
 *
 * Read-only status:
 *   node run-weekly-menu-cache-upload-v5.mjs --status
 *
 * Offline validation (no network and no filesystem writes):
 *   node run-weekly-menu-cache-upload-v5.mjs --validate --self-test
 *
 * Contract:
 * - The complete shop list is downloaded at most once every seven days.
 * - A new weekly menu generation is downloaded with a 20-store worker pool.
 * - No upload begins until every store in that generation has a valid cache.
 * - Every two hours the active generation is uploaded to every store using a
 *   10-worker pool. A worker owns only one store at a time.
 * - The mutable endpoint is only uploadGrocery with merge_policy=1.
 * - Every returned upload task ID is durably checkpointed and polled.
 * - An interrupted submission without a task ID is never repeated in the same
 *   cycle because its outcome is ambiguous.
 */

const require = createRequire(import.meta.url);
const RUNNER_PATH = fileURLToPath(import.meta.url);
const BACKEND_ROOT = path.resolve(path.dirname(RUNNER_PATH), '..');
// Keep menus and checkpoints on the backend's persistent uploads volume.
const ROOT = path.resolve(process.env.DIDI_NETO_DATA_ROOT ?? path.join(BACKEND_ROOT, 'uploads', 'tiendas-neto'));
const HELPERS = Object.freeze({
  destination: path.join(BACKEND_ROOT, 'dist', 'file-integrations', 'grocery-destination-menu.util.js'),
  upload: path.join(BACKEND_ROOT, 'dist', 'file-integrations', 'grocery-menu-upload.util.js'),
  limiter: path.join(BACKEND_ROOT, 'dist', 'file-integrations', 'grocery-task-status-limiter.js'),
  didi: path.join(BACKEND_ROOT, 'dist', 'queue', 'handlers', 'didi-food.util.js'),
});

const {
  ALLOWED_GROCERY_CATEGORY_NAMES,
  buildFlatGroceryUploads,
  isGroceryDestinationItemUploadable,
} = require(HELPERS.destination);
const {
  GroceryBatchSubmissionRejectedError,
  checkGroceryUploadTaskOnce,
  submitGroceryBatch,
} = require(HELPERS.upload);
const {
  GROCERY_TASK_STATUS_MIN_INTERVAL_MS,
  withGroceryTaskStatusRateLimit,
} = require(HELPERS.limiter);
const {
  DIDI_BASE,
  fetchWithEndpointContext,
  generateSignature,
  parseJsonKeepingIds,
} = require(HELPERS.didi);

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const POLICY_VERSION = 'tiendas-neto-weekly-menu-cache-upload-v5';
const APP_ID_EXPECTED = '5764607780881696497';
const MERGE_POLICY = 1;
const UPLOAD_ENDPOINT = 'uploadGrocery';
const WEEK_MS = 7 * 24 * 60 * 60_000;
const UPLOAD_INTERVAL_MS = 2 * 60 * 60_000;
const DOWNLOAD_WORKERS = 20;
const UPLOAD_WORKERS = 10;
const SHOP_PAGE_SIZE = 100;
const SHOP_PAGE_INTERVAL_MS = 20_000;
const EXPORT_CREATE_INTERVAL_MS = 6_000;
const EXPORT_MATURITY_MS = 60_000;
const TASK_RECHECK_MS = 10_000;
const TASK_TIMEOUT_MS = 45 * 60_000;
const MAX_MENU_BYTES = 60 * 1024 * 1024;
const MAX_MENU_ITEMS = 3_500;
const UPLOAD_START_INTERVAL_MS = 250;

const ARGS = new Set(process.argv.slice(2));
const STATUS_ONLY = ARGS.has('--status');
const VALIDATE_ONLY = ARGS.has('--validate');
const SELF_TEST = ARGS.has('--self-test');
const AUTH_TEST = ARGS.has('--auth-test');
if (SELF_TEST && !VALIDATE_ONLY) throw new Error('--self-test requires --validate');
if (AUTH_TEST && (STATUS_ONLY || VALIDATE_ONLY)) throw new Error('--auth-test cannot be combined with other modes');
if ([...ARGS].some(arg => !['--status', '--validate', '--self-test', '--auth-test'].includes(arg))) {
  throw new Error('Supported arguments: --status, --validate, --self-test, --auth-test');
}

const APP_ID = String(process.env.DIDI_APP_ID ?? (STATUS_ONLY || VALIDATE_ONLY ? APP_ID_EXPECTED : '')).trim();
const APP_SECRET = String(process.env.DIDI_APP_SECRET ?? '').trim();
if (APP_ID !== APP_ID_EXPECTED) throw new Error('DIDI_APP_ID must be the Tiendas Neto application ID');
if (!STATUS_ONLY && !VALIDATE_ONLY && !APP_SECRET) throw new Error('DIDI_APP_SECRET is required for live execution');

const DATA_ROOT = path.join(ROOT, 'weekly-menu-v5');
const INVENTORY_PATH = path.join(DATA_ROOT, 'shop-list.json.gz');
const CONTROL_PATH = path.join(DATA_ROOT, 'daemon-state.json');
const STATUS_PATH = path.join(DATA_ROOT, 'status.json');
const GENERATIONS_DIR = path.join(DATA_ROOT, 'generations');
const CYCLES_DIR = path.join(DATA_ROOT, 'cycles');
const LEGACY_INVENTORY_PATH = path.join(ROOT, 'shops.json.gz');
const LOCK_PATHS = [
  path.join(ROOT, 'operation.lock'),
  path.join(ROOT, 'bulk-crosscopy-merge1.lock'),
  path.join(ROOT, 'bulk-crosscopy-batches10.lock'),
  path.join(ROOT, 'bulk-crosscopy-fast3.lock'),
  path.join(ROOT, 'bulk-crosscopy-wave4.lock'),
  path.join(ROOT, 'weekly-menu-v5.lock'),
];

let apiCalls = 0;
let filesystemWrites = 0;
let stopRequested = false;
let signalCount = 0;
const lockToken = crypto.randomUUID();
const acquiredLocks = [];
const lockHost = os.hostname();
const LOCK_STALE_MS = 120_000;
let lockHeartbeat;

function now() { return new Date().toISOString(); }
function text(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function safeKey(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, '_'); }
function json(value) { return JSON.stringify(value, null, 2) + '\n'; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function generationId() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function publicError(error) {
  let value = String(error instanceof Error ? error.message : error);
  if (APP_SECRET) value = value.replaceAll(APP_SECRET, '[REDACTED]');
  return value
    .replace(/(["']?(?:auth[_-]?token|app[_-]?secret)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi, '$1[REDACTED]')
    .slice(0, 8_000);
}
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /(?:app[_-]?secret|auth[_-]?token)/i.test(key) ? '[REDACTED]' : publicValue(entry),
    ]));
  }
  return typeof value === 'string' ? publicError(value) : value;
}
function parseDate(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
function isFresh(timestamp, ttl = WEEK_MS) {
  const parsed = parseDate(timestamp);
  return parsed > 0 && parsed <= Date.now() && Date.now() - parsed < ttl;
}
function ensureNotStopping() {
  if (stopRequested) throw new Error('Graceful stop requested');
}

class StartRateGate {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.tail = Promise.resolve();
    this.nextAt = 0;
  }
  async wait() {
    const slot = this.tail.then(async () => {
      const waitMs = Math.max(0, this.nextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      this.nextAt = Date.now() + this.minIntervalMs;
    });
    this.tail = slot.catch(() => undefined);
    await slot;
  }
}

const exportCreateGate = new StartRateGate(EXPORT_CREATE_INTERVAL_MS);
const authGate = new StartRateGate(100);
const uploadGate = new StartRateGate(UPLOAD_START_INTERVAL_MS);

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  filesystemWrites += 1;
  await fs.writeFile(temporary, json(publicValue(value)), 'utf8');
  await fs.rename(temporary, file);
}
async function atomicWriteGzip(file, raw) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  filesystemWrites += 1;
  await fs.writeFile(temporary, await gzip(Buffer.from(raw), { level: 9 }));
  await fs.rename(temporary, file);
}
async function readJsonIfExists(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}
async function readGzipJsonIfExists(file) {
  try { return parseJsonKeepingIds((await gunzip(await fs.readFile(file))).toString('utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}
async function readGzipText(file) {
  return (await gunzip(await fs.readFile(file))).toString('utf8');
}
async function fileExists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function validateInventory(envelope) {
  if (text(envelope?.appId) !== APP_ID_EXPECTED) throw new Error('Shop inventory belongs to another application');
  if (!Array.isArray(envelope?.shops) || !envelope.shops.length) throw new Error('Shop inventory is empty');
  if (Number(envelope.total) !== envelope.shops.length) throw new Error('Shop inventory total is incomplete');
  const shopIds = new Set();
  const appShopIds = new Set();
  for (const shop of envelope.shops) {
    const shopId = text(shop?.shop_id);
    const appShopId = text(shop?.app_shop_id);
    if (!/^\d+$/.test(shopId) || !/^\d+$/.test(appShopId)) throw new Error('Shop inventory contains invalid IDs');
    if (shopIds.has(shopId) || appShopIds.has(appShopId)) throw new Error('Shop inventory contains duplicate IDs');
    shopIds.add(shopId);
    appShopIds.add(appShopId);
  }
  if (!parseDate(envelope.fetchedAt)) throw new Error('Shop inventory has no valid fetchedAt timestamp');
  return envelope;
}

async function requestJson(endpoint, url, init = {}, { allowPending = false, timeoutMs = 90_000 } = {}) {
  apiCalls += 1;
  const response = await fetchWithEndpointContext(endpoint, url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  const body = parseJsonKeepingIds(raw);
  const errno = Number(body?.errno);
  if (allowPending && (errno === 10005 || /task\s*(?:\([^)]*\))?\s*not found|task not found/i.test(text(body?.errmsg)))) {
    return { body, pending: true };
  }
  if (!response.ok || errno !== 0) {
    const error = new Error(`${endpoint} failed: ${text(body?.errmsg ?? body?.message) || `HTTP ${response.status}`} (errno=${body?.errno ?? 'unknown'})`);
    error.errno = errno;
    throw error;
  }
  return { body, pending: false };
}

async function getShopToken(appShopId) {
  ensureNotStopping();
  await authGate.wait();
  // The older shared DiDi helper in production expects a refresh_token that
  // this API does not return. Keep Neto's proven two-step flow isolated here.
  const query = new URLSearchParams({ app_id: APP_ID, app_secret: APP_SECRET, app_shop_id: appShopId });
  const refreshed = await requestJson(
    'GET /v1/auth/authtoken/refresh',
    `${DIDI_BASE}/v1/auth/authtoken/refresh?${query}`,
    {},
    { timeoutMs: 30_000 },
  );
  if (refreshed.body?.data !== true) throw new Error('DiDi did not confirm the shop token refresh');
  const received = await requestJson(
    'GET /v1/auth/authtoken/get',
    `${DIDI_BASE}/v1/auth/authtoken/get?${query}`,
    {},
    { timeoutMs: 30_000 },
  );
  const token = text(received.body?.data?.auth_token);
  if (!token) throw new Error('DiDi returned no shop auth token');
  return token;
}

async function fetchAllShops() {
  const shops = [];
  const seenShopIds = new Set();
  const seenAppShopIds = new Set();
  let expectedTotal;
  for (let pageNo = 1; pageNo <= 1_000; pageNo += 1) {
    ensureNotStopping();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const payload = { app_id: APP_ID, page_no: pageNo, page_size: SHOP_PAGE_SIZE, timestamp };
    payload.sign = generateSignature(payload, APP_SECRET);
    let result;
    for (;;) {
      try {
        result = await requestJson('POST /v1/shop/shop/list', `${DIDI_BASE}/v1/shop/shop/list`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        break;
      } catch (error) {
        if (error?.errno !== 10005) throw error;
        console.log(`[${now()}] SHOP_LIST_RATE_LIMIT page=${pageNo} retry_in_ms=${SHOP_PAGE_INTERVAL_MS}`);
        await sleep(SHOP_PAGE_INTERVAL_MS);
      }
    }
    const page = Array.isArray(result.body?.data?.shop_list) ? result.body.data.shop_list : [];
    const total = Number(result.body?.data?.total);
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error(`shop/list page ${pageNo} returned invalid total`);
    if (expectedTotal === undefined) expectedTotal = total;
    if (expectedTotal !== total) throw new Error(`shop/list total changed (${expectedTotal} -> ${total})`);
    for (const rawShop of page) {
      const shopId = text(rawShop?.shop_id);
      const appShopId = text(rawShop?.app_shop_id);
      if (!shopId || !appShopId || seenShopIds.has(shopId) || seenAppShopIds.has(appShopId)) {
        throw new Error(`shop/list returned invalid or duplicate IDs on page ${pageNo}`);
      }
      seenShopIds.add(shopId);
      seenAppShopIds.add(appShopId);
      shops.push({ ...rawShop, shop_id: shopId, app_shop_id: appShopId });
    }
    console.log(`[${now()}] SHOP_LIST_PAGE page=${pageNo} rows=${page.length} accumulated=${shops.length} total=${total}`);
    if (shops.length >= total || page.length < SHOP_PAGE_SIZE) break;
    await sleep(SHOP_PAGE_INTERVAL_MS);
  }
  const envelope = { schemaVersion: 2, appId: APP_ID, fetchedAt: now(), total: shops.length, shops };
  return validateInventory(envelope);
}

async function ensureInventory() {
  let inventory = await readGzipJsonIfExists(INVENTORY_PATH);
  if (inventory) validateInventory(inventory);
  if (inventory && isFresh(inventory.fetchedAt)) {
    console.log(`[${now()}] SHOP_LIST_CACHE_HIT fetched_at=${inventory.fetchedAt} stores=${inventory.total}`);
    return inventory;
  }
  if (!inventory) {
    const legacy = await readGzipJsonIfExists(LEGACY_INVENTORY_PATH);
    if (legacy) {
      validateInventory(legacy);
      if (isFresh(legacy.fetchedAt)) {
        await atomicWriteGzip(INVENTORY_PATH, json({ ...legacy, schemaVersion: 2, adoptedAt: now() }));
        console.log(`[${now()}] SHOP_LIST_ADOPTED fetched_at=${legacy.fetchedAt} stores=${legacy.total}`);
        return legacy;
      }
    }
  }
  console.log(`[${now()}] SHOP_LIST_REFRESH_START`);
  inventory = await fetchAllShops();
  await atomicWriteGzip(INVENTORY_PATH, json(inventory));
  console.log(`[${now()}] SHOP_LIST_REFRESH_DONE stores=${inventory.total}`);
  return inventory;
}

function generationPath(id) { return path.join(GENERATIONS_DIR, safeKey(id)); }
function generationMetaPath(id) { return path.join(generationPath(id), 'generation.json'); }
function downloadStatePath(id, appShopId) { return path.join(generationPath(id), 'states', `${safeKey(appShopId)}.json`); }
function originalMenuPath(id, appShopId) { return path.join(generationPath(id), 'originals', `${safeKey(appShopId)}.json.gz`); }
function uploadMenuPath(id, appShopId) { return path.join(generationPath(id), 'uploads', `${safeKey(appShopId)}.json.gz`); }
function generationInventoryPath(id) { return path.join(generationPath(id), 'shop-list.json.gz'); }
function cyclePath(id) { return path.join(CYCLES_DIR, safeKey(id)); }
function cycleMetaPath(id) { return path.join(cyclePath(id), 'cycle.json'); }
function uploadStatePath(id, appShopId) { return path.join(cyclePath(id), 'states', `${safeKey(appShopId)}.json`); }

function validateSourceMenu(menu) {
  if (!Array.isArray(menu?.menus) || menu.menus.length !== 1) throw new Error('Source must contain exactly one menu');
  if (!Array.isArray(menu?.items) || !menu.items.length) throw new Error('Source menu contains no items');
  if (menu.items.length > MAX_MENU_ITEMS) throw new Error(`Source contains more than ${MAX_MENU_ITEMS} items`);
  if (Array.isArray(menu?.modifier_groups) && menu.modifier_groups.length) throw new Error('Source contains modifier groups');
  const seen = new Set();
  for (const item of menu.items) {
    const id = text(item?.app_item_id);
    if (!id || seen.has(id)) throw new Error('Source contains blank or duplicate app_item_id');
    seen.add(id);
    if (!text(item?.upc)) throw new Error(`Item ${id} has no UPC`);
    if (!['1', '2'].includes(text(item?.status))) throw new Error(`Item ${id} has unsupported status ${text(item?.status) || 'missing'}`);
  }
}

function buildCrossCopyPayload(menu) {
  validateSourceMenu(menu);
  const normalizedItems = structuredClone(menu.items);
  let changed2To1 = 0;
  let already1 = 0;
  for (const item of normalizedItems) {
    if (text(item.status) === '2') {
      item.status = 1;
      changed2To1 += 1;
    } else {
      item.status = 1;
      already1 += 1;
    }
  }
  const uploadable = normalizedItems.filter(isGroceryDestinationItemUploadable);
  if (uploadable.length !== normalizedItems.length) {
    throw new Error(`CrossCopy would skip ${normalizedItems.length - uploadable.length} item(s)`);
  }
  const batches = buildFlatGroceryUploads({ ...menu, items: normalizedItems }, uploadable, undefined, true);
  if (batches.length !== 1) throw new Error(`CrossCopy produced ${batches.length} payloads; expected one`);
  const payload = batches[0];
  if (payload.items.length !== menu.items.length || payload.items.some(item => text(item.status) !== '1')) {
    throw new Error('CrossCopy payload integrity check failed');
  }
  return { payload, sourceItems: menu.items.length, changed2To1, already1 };
}

function validateCachedCrossCopyPayload(payload) {
  if (!Array.isArray(payload?.menus) || payload.menus.length !== 1) {
    throw new Error('Cached CrossCopy payload must contain exactly one menu');
  }
  if (!Array.isArray(payload?.categories) || !payload.categories.length) {
    throw new Error('Cached CrossCopy payload contains no categories');
  }
  if (!Array.isArray(payload?.items) || !payload.items.length) {
    throw new Error('Cached CrossCopy payload contains no items');
  }
  if (payload.items.some(item => text(item.status) !== '1')) {
    throw new Error('Cached CrossCopy payload contains a status other than 1');
  }
  const expectedCategoryIds = payload.categories.map((_, index) => `Cate_Grocery_${index + 1}`);
  const actualCategoryIds = payload.categories.map(category => text(category.app_category_id));
  if (actualCategoryIds.join('\u0000') !== expectedCategoryIds.join('\u0000')) {
    throw new Error('Cached payload does not use sequential CrossCopy category IDs');
  }
  payload.categories.forEach((category, index) => {
    if (text(category.category_name) !== ALLOWED_GROCERY_CATEGORY_NAMES[index]) {
      throw new Error(`Cached category ${index + 1} does not use the approved CrossCopy name`);
    }
  });
  const menuCategoryIds = Array.isArray(payload.menus[0]?.app_category_ids)
    ? payload.menus[0].app_category_ids.map(text)
    : [];
  if (menuCategoryIds.join('\u0000') !== expectedCategoryIds.join('\u0000')) {
    throw new Error('Cached menu/category relationship does not match CrossCopy');
  }
  const itemIds = payload.items.map(item => text(item.app_item_id));
  if (itemIds.some(id => !id) || new Set(itemIds).size !== itemIds.length) {
    throw new Error('Cached CrossCopy payload contains blank or duplicate item IDs');
  }
  const categoryItemIds = payload.categories.flatMap(category => (
    Array.isArray(category.app_item_ids) ? category.app_item_ids.map(text) : []
  ));
  if (categoryItemIds.length !== itemIds.length
    || new Set(categoryItemIds).size !== categoryItemIds.length
    || [...itemIds].sort().join('\u0000') !== [...categoryItemIds].sort().join('\u0000')) {
    throw new Error('Cached CrossCopy categories do not contain every item exactly once');
  }
}

async function createExportTask(authToken) {
  await exportCreateGate.wait();
  const result = await requestJson('POST /v3/item/item/menu', `${DIDI_BASE}/v3/item/item/menu`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_token: authToken }),
  });
  const taskId = text(result.body?.data?.taskID ?? result.body?.data?.taskId);
  if (!taskId) throw new Error('Menu export did not return a taskID');
  return taskId;
}

function exportResult(body, taskId) {
  const status = Number(body?.data?.status);
  if ([0, 3, 4].includes(status) || !Number.isFinite(status)) return { kind: 'pending', status };
  const operations = Array.isArray(body?.data?.operationList) ? body.data.operationList : [];
  const completed = operations.find(operation => operation?.operationType === 'menuExportDone');
  const url = Array.isArray(completed?.successList)
    ? completed.successList.find(value => typeof value === 'string')
    : undefined;
  if (status === 1 && url) return { kind: 'success', status, url };
  if ([2, 5].includes(status)) return { kind: 'failed', status, detail: publicValue(operations).slice(0, 10) };
  if (status === 1) throw new Error(`Export task ${taskId} succeeded without a download URL`);
  throw new Error(`Export task ${taskId} returned unsupported status ${status}`);
}

async function pollExportTask(authToken, taskId) {
  return withGroceryTaskStatusRateLimit(async () => {
    const result = await requestJson(
      'POST /v3/item/item/getGroceryMenuTaskInfo',
      `${DIDI_BASE}/v3/item/item/getGroceryMenuTaskInfo`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: authToken, task_id: taskId }),
      },
      { allowPending: true },
    );
    if (result.pending) return { kind: 'pending' };
    return exportResult(result.body, taskId);
  }, APP_ID);
}

async function downloadMenuUrl(downloadUrl) {
  const url = new URL(downloadUrl);
  if (!['http:', 'https:'].includes(url.protocol)
    || (url.hostname !== 'didiglobal.com' && !url.hostname.endsWith('.didiglobal.com'))) {
    throw new Error(`Untrusted menu download host ${url.hostname}`);
  }
  apiCalls += 1;
  const response = await fetchWithEndpointContext(`GET menu download (${url.hostname})`, url, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Menu download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_MENU_BYTES) throw new Error('Menu download exceeds the 60 MB limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MENU_BYTES) throw new Error('Menu download exceeds the 60 MB limit');
  const raw = buffer.toString('utf8');
  return { raw, menu: parseJsonKeepingIds(raw) };
}

async function ensureGenerationDirectories(id) {
  for (const directory of [
    generationPath(id),
    path.join(generationPath(id), 'states'),
    path.join(generationPath(id), 'originals'),
    path.join(generationPath(id), 'uploads'),
  ]) await fs.mkdir(directory, { recursive: true });
}

async function downloadOneStore(generation, shop) {
  const appShopId = text(shop.app_shop_id);
  const stateFile = downloadStatePath(generation.id, appShopId);
  let state = await readJsonIfExists(stateFile) ?? {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    generationId: generation.id,
    appShopId,
    shopId: text(shop.shop_id),
    status: 'pending',
    exportAttempts: 0,
    createdAt: now(),
  };
  const save = async () => {
    state.updatedAt = now();
    await atomicWriteJson(stateFile, state);
  };
  if (state.status === 'cached') {
    const originalExists = await fileExists(originalMenuPath(generation.id, appShopId));
    const uploadExists = await fileExists(uploadMenuPath(generation.id, appShopId));
    if (originalExists && uploadExists) return { status: 'cached', appShopId };
    state.status = 'pending';
    state.lastError = 'Cached artifacts were missing; export will be repeated';
    delete state.exportTaskId;
    await save();
  }
  ensureNotStopping();
  let token = await getShopToken(appShopId);
  if (!state.exportTaskId) {
    state.status = 'export_requesting';
    state.exportAttempts = Number(state.exportAttempts ?? 0) + 1;
    state.exportRequestedAt = now();
    await save();
    try {
      state.exportTaskId = await createExportTask(token);
      state.status = 'export_requested';
      await save();
      console.log(`[${now()}] EXPORT_REQUESTED app_shop_id=${appShopId} task_id=${state.exportTaskId}`);
    } catch (error) {
      state.status = 'export_create_failed';
      state.lastError = publicError(error);
      await save();
      throw error;
    }
  }
  const age = Date.now() - parseDate(state.exportRequestedAt);
  if (age < EXPORT_MATURITY_MS) await sleep(EXPORT_MATURITY_MS - age);
  const pollStartedAt = Date.now();
  for (;;) {
    ensureNotStopping();
    if (Date.now() - pollStartedAt > TASK_TIMEOUT_MS) {
      state.status = 'export_poll_timeout';
      state.lastError = `Export task ${state.exportTaskId} did not finish in ${TASK_TIMEOUT_MS / 60_000} minutes`;
      await save();
      throw new Error(state.lastError);
    }
    let result;
    try {
      result = await pollExportTask(token, state.exportTaskId);
    } catch (error) {
      if (error?.errno === 10102) {
        token = await getShopToken(appShopId);
        continue;
      }
      state.lastError = publicError(error);
      state.lastPollErrorAt = now();
      await save();
      await sleep(TASK_RECHECK_MS);
      continue;
    }
    state.polls = Number(state.polls ?? 0) + 1;
    state.lastPollAt = now();
    if (result.kind === 'pending') {
      state.status = 'export_pending';
      await save();
      await sleep(TASK_RECHECK_MS);
      continue;
    }
    if (result.kind === 'failed') {
      state.status = 'export_failed';
      state.exportResultStatus = result.status;
      state.lastError = `Export task failed with status ${result.status}`;
      state.exportFailure = result.detail;
      delete state.exportTaskId;
      delete state.exportRequestedAt;
      await save();
      throw new Error(state.lastError);
    }
    const downloaded = await downloadMenuUrl(result.url);
    const built = buildCrossCopyPayload(downloaded.menu);
    const uploadRaw = json(built.payload);
    await atomicWriteGzip(originalMenuPath(generation.id, appShopId), downloaded.raw);
    await atomicWriteGzip(uploadMenuPath(generation.id, appShopId), uploadRaw);
    state.status = 'cached';
    state.cachedAt = now();
    state.exportResultStatus = result.status;
    state.originalSha256 = sha256(downloaded.raw);
    state.uploadSha256 = sha256(uploadRaw);
    state.sourceItems = built.sourceItems;
    state.changed2To1 = built.changed2To1;
    state.already1 = built.already1;
    delete state.lastError;
    await save();
    console.log(`[${now()}] MENU_CACHED app_shop_id=${appShopId} items=${built.sourceItems} changed_2_to_1=${built.changed2To1}`);
    return { status: 'cached', appShopId, items: built.sourceItems, changed: built.changed2To1 };
  }
}

async function runPool(values, concurrency, worker, onSettled) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async (_, workerIndex) => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        const value = await worker(values[index], workerIndex + 1);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason: publicError(reason) };
      }
      if (onSettled) await onSettled(results[index], values[index], workerIndex + 1);
      if (stopRequested) return;
    }
  });
  await Promise.all(runners);
  return results;
}

let statusWriteTail = Promise.resolve();
let liveStatus = {};
async function setStatus(patch) {
  liveStatus = {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    pid: process.pid,
    appId: APP_ID,
    downloadWorkers: DOWNLOAD_WORKERS,
    uploadWorkers: UPLOAD_WORKERS,
    inventoryTtlHours: WEEK_MS / 3_600_000,
    menuTtlHours: WEEK_MS / 3_600_000,
    uploadIntervalHours: UPLOAD_INTERVAL_MS / 3_600_000,
    uploadEndpoint: UPLOAD_ENDPOINT,
    mergePolicy: MERGE_POLICY,
    taskStatusMinIntervalMs: GROCERY_TASK_STATUS_MIN_INTERVAL_MS,
    ...liveStatus,
    ...patch,
    apiCalls,
    filesystemWrites,
    updatedAt: now(),
  };
  statusWriteTail = statusWriteTail.then(() => atomicWriteJson(STATUS_PATH, liveStatus));
  await statusWriteTail;
}

async function buildGeneration(control, inventory) {
  let id = text(control.buildingGenerationId);
  let generation;
  if (id) generation = await readJsonIfExists(generationMetaPath(id));
  if (!generation) {
    id = generationId();
    generation = {
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      id,
      status: 'downloading',
      createdAt: now(),
      inventoryFetchedAt: inventory.fetchedAt,
      stores: inventory.total,
      downloadWorkers: DOWNLOAD_WORKERS,
    };
    await ensureGenerationDirectories(id);
    await atomicWriteGzip(generationInventoryPath(id), json(inventory));
    await atomicWriteJson(generationMetaPath(id), generation);
    control.buildingGenerationId = id;
    await atomicWriteJson(CONTROL_PATH, control);
  } else {
    await ensureGenerationDirectories(id);
    inventory = validateInventory(await readGzipJsonIfExists(generationInventoryPath(id)));
  }
  const shops = [...inventory.shops].sort((a, b) => text(a.app_shop_id).localeCompare(text(b.app_shop_id), undefined, { numeric: true }));
  const failureStatuses = new Set(['export_failed', 'export_create_failed', 'export_poll_timeout']);
  const pending = [];
  let cachedBefore = 0;
  let skippedBefore = 0;
  for (const shop of shops) {
    const state = await readJsonIfExists(downloadStatePath(id, shop.app_shop_id));
    const cached = state?.status === 'cached'
      && await fileExists(originalMenuPath(id, shop.app_shop_id))
      && await fileExists(uploadMenuPath(id, shop.app_shop_id));
    if (cached) cachedBefore += 1;
    else if (failureStatuses.has(text(state?.status))) skippedBefore += 1;
    else pending.push(shop);
  }
  const pass = 1;
  generation.passes = pass;
  generation.downloadFailurePolicy = 'omit_after_first_attempt';
  generation.lastPassStartedAt ??= now();
  generation.pendingAtPassStart ??= pending.length;
  await atomicWriteJson(generationMetaPath(id), generation);
  const progress = {
    total: shops.length,
    cached: cachedBefore,
    skipped: skippedBefore,
    failedThisPass: 0,
    inFlight: 0,
    pass,
  };
  await setStatus({ phase: 'weekly_download', generationId: id, progress });
  console.log(`[${now()}] DOWNLOAD_PASS_RESUME generation=${id} pending=${pending.length} cached=${cachedBefore} skipped=${skippedBefore} workers=${DOWNLOAD_WORKERS}`);
  await runPool(
    pending,
    DOWNLOAD_WORKERS,
    async shop => {
      progress.inFlight += 1;
      try { return await downloadOneStore(generation, shop); }
      finally { progress.inFlight -= 1; }
    },
    async result => {
      if (result.status === 'fulfilled') progress.cached += 1;
      else {
        progress.failedThisPass += 1;
        progress.skipped += 1;
      }
      await setStatus({ phase: 'weekly_download', generationId: id, progress: { ...progress } });
    },
  );
  ensureNotStopping();
  generation.lastPassCompletedAt = now();
  const eligible = await cachedGenerationShops(generation, inventory);
  const skipped = shops.length - eligible.length;
  if (!eligible.length) throw new Error('No valid menus were downloaded; upload cannot start');
  generation.status = 'active';
  generation.completedAt = now();
  generation.expiresAt = new Date(Date.now() + WEEK_MS).toISOString();
  generation.cachedStores = eligible.length;
  generation.skippedStores = skipped;
  await atomicWriteJson(generationMetaPath(id), generation);
  control.activeGenerationId = id;
  control.activeGenerationCompletedAt = generation.completedAt;
  delete control.buildingGenerationId;
  control.nextUploadAt = now();
  await atomicWriteJson(CONTROL_PATH, control);
  await setStatus({ phase: 'weekly_download_complete', generationId: id, progress: { total: shops.length, cached: eligible.length, skipped, failedThisPass: progress.failedThisPass, inFlight: 0, pass } });
  console.log(`[${now()}] GENERATION_ACTIVE generation=${id} cached=${eligible.length} skipped=${skipped}`);
  return { control, generation, inventory };
}

async function cachedGenerationShops(generation, inventory) {
  const eligible = [];
  for (const shop of inventory.shops) {
    const appShopId = text(shop.app_shop_id);
    const state = await readJsonIfExists(downloadStatePath(generation.id, appShopId));
    if (state?.status === 'cached'
      && await fileExists(originalMenuPath(generation.id, appShopId))
      && await fileExists(uploadMenuPath(generation.id, appShopId))) eligible.push(shop);
  }
  return eligible.sort((a, b) => text(a.app_shop_id).localeCompare(text(b.app_shop_id), undefined, { numeric: true }));
}

async function loadActiveGeneration(control) {
  const id = text(control.activeGenerationId);
  if (!id) return undefined;
  const generation = await readJsonIfExists(generationMetaPath(id));
  if (!generation || generation.status !== 'active') return undefined;
  const inventory = await readGzipJsonIfExists(generationInventoryPath(id));
  validateInventory(inventory);
  return { generation, inventory };
}

async function ensureFreshGeneration(control, inventory) {
  const active = await loadActiveGeneration(control);
  // Finish an interrupted upload cycle with the exact menu generation it started with.
  if (active && (text(control.currentCycleId) || isFresh(active.generation.completedAt))) return { control, ...active };
  return buildGeneration(control, inventory);
}

async function ensureCycleDirectories(id) {
  await fs.mkdir(path.join(cyclePath(id), 'states'), { recursive: true });
}

async function pollUploadToTerminal(shop, state, save) {
  const appShopId = text(shop.app_shop_id);
  let token = await getShopToken(appShopId);
  const startedAt = Date.now();
  for (;;) {
    ensureNotStopping();
    if (Date.now() - startedAt > TASK_TIMEOUT_MS) {
      state.status = 'task_poll_timeout';
      state.lastError = `Upload task ${state.uploadTaskId} remains pending after ${TASK_TIMEOUT_MS / 60_000} minutes`;
      await save();
      return { status: state.status, appShopId };
    }
    try {
      apiCalls += 1;
      const check = await checkGroceryUploadTaskOnce(
        token,
        state.uploadTaskId,
        async () => getShopToken(appShopId),
        APP_ID,
      );
      token = check.authToken;
      state.polls = Number(state.polls ?? 0) + 1;
      state.lastPollAt = now();
      state.lastTaskStatus = check.status;
      if (!check.terminal) {
        state.status = 'task_pending';
        await save();
        await sleep(TASK_RECHECK_MS);
        continue;
      }
      state.failedItems = check.failedItems;
      state.completedAt = now();
      if (check.status === 1) state.status = 'succeeded';
      else if (check.status === 5) state.status = 'partial_success';
      else state.status = 'failed';
      delete state.lastError;
      await save();
      console.log(`[${now()}] UPLOAD_TASK_DONE app_shop_id=${appShopId} task_id=${state.uploadTaskId} status=${check.status} result=${state.status}`);
      return { status: state.status, appShopId, taskId: state.uploadTaskId };
    } catch (error) {
      state.pollErrors = Number(state.pollErrors ?? 0) + 1;
      state.lastError = publicError(error);
      state.lastPollErrorAt = now();
      await save();
      await sleep(TASK_RECHECK_MS);
    }
  }
}

async function uploadOneStore(cycle, generation, shop) {
  const appShopId = text(shop.app_shop_id);
  const stateFile = uploadStatePath(cycle.id, appShopId);
  let state = await readJsonIfExists(stateFile) ?? {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    cycleId: cycle.id,
    generationId: generation.id,
    appShopId,
    shopId: text(shop.shop_id),
    status: 'pending',
    createdAt: now(),
  };
  const save = async () => {
    state.updatedAt = now();
    await atomicWriteJson(stateFile, state);
  };
  if (['succeeded', 'partial_success', 'failed', 'submission_rejected', 'ambiguous_submission', 'task_poll_timeout'].includes(state.status)) {
    return { status: state.status, appShopId, taskId: state.uploadTaskId, newTaskId: false };
  }
  if (state.status === 'submitting' && !state.uploadTaskId) {
    state.status = 'ambiguous_submission';
    state.lastError = 'Runner stopped after the mutable boundary and before a task ID was saved; this cycle will not repeat the request';
    await save();
    return { status: state.status, appShopId, newTaskId: false };
  }
  if (state.uploadTaskId) {
    return { ...await pollUploadToTerminal(shop, state, save), newTaskId: false };
  }

  const payloadRaw = await readGzipText(uploadMenuPath(generation.id, appShopId));
  const payload = parseJsonKeepingIds(payloadRaw);
  try {
    validateCachedCrossCopyPayload(payload);
  } catch (error) {
    state.status = 'cache_integrity_failed';
    state.lastError = publicError(error);
    await save();
    return { status: state.status, appShopId, newTaskId: false };
  }
  if (sha256(payloadRaw) !== text((await readJsonIfExists(downloadStatePath(generation.id, appShopId)))?.uploadSha256)) {
    state.status = 'cache_integrity_failed';
    state.lastError = 'Cached upload payload SHA-256 does not match the weekly checkpoint';
    await save();
    return { status: state.status, appShopId, newTaskId: false };
  }
  const token = await getShopToken(appShopId);
  await uploadGate.wait();
  state.status = 'submitting';
  state.submittingAt = now();
  state.items = payload.items.length;
  state.payloadSha256 = sha256(payloadRaw);
  await save();
  let submission;
  try {
    apiCalls += 1;
    submission = await submitGroceryBatch(token, payload, UPLOAD_ENDPOINT, MERGE_POLICY);
    if ('acceptedCount' in submission || !text(submission.referenceId)) throw new Error('uploadGrocery did not return a task ID');
  } catch (error) {
    state.lastError = publicError(error);
    state.failedAt = now();
    state.status = error instanceof GroceryBatchSubmissionRejectedError
      ? 'submission_rejected'
      : 'ambiguous_submission';
    await save();
    return { status: state.status, appShopId, newTaskId: false };
  }
  state.uploadTaskId = text(submission.referenceId);
  state.submittedAt = now();
  state.status = 'task_submitted';
  await save();
  console.log(`[${now()}] UPLOAD_SUBMITTED app_shop_id=${appShopId} task_id=${state.uploadTaskId} items=${payload.items.length}`);
  return { ...await pollUploadToTerminal(shop, state, save), newTaskId: true };
}

async function summarizeCycle(cycle, shops) {
  const byStatus = {};
  let taskIds = 0;
  for (const shop of shops) {
    const state = await readJsonIfExists(uploadStatePath(cycle.id, shop.app_shop_id));
    const status = text(state?.status) || 'missing';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (text(state?.uploadTaskId)) taskIds += 1;
  }
  return { byStatus, taskIds };
}

async function runUploadCycle(control, generation, inventory) {
  const shops = await cachedGenerationShops(generation, inventory);
  const skippedDownloads = inventory.total - shops.length;
  if (!shops.length) throw new Error('The active generation contains no downloadable store menus');
  let id = text(control.currentCycleId);
  let cycle = id ? await readJsonIfExists(cycleMetaPath(id)) : undefined;
  if (!cycle) {
    id = `cycle-${generationId()}`;
    cycle = {
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      id,
      generationId: generation.id,
      status: 'running',
      startedAt: now(),
      stores: shops.length,
      skippedDownloads,
      workers: UPLOAD_WORKERS,
      endpoint: UPLOAD_ENDPOINT,
      mergePolicy: MERGE_POLICY,
    };
    await ensureCycleDirectories(id);
    await atomicWriteJson(cycleMetaPath(id), cycle);
    control.currentCycleId = id;
    await atomicWriteJson(CONTROL_PATH, control);
  } else {
    await ensureCycleDirectories(id);
    if (cycle.generationId !== generation.id) throw new Error('An unfinished upload cycle belongs to another menu generation');
  }
  const initial = await summarizeCycle(cycle, shops);
  const terminal = new Set(['succeeded', 'partial_success', 'failed', 'submission_rejected', 'ambiguous_submission', 'task_poll_timeout', 'cache_integrity_failed']);
  const pending = [];
  for (const shop of shops) {
    const state = await readJsonIfExists(uploadStatePath(id, shop.app_shop_id));
    if (!terminal.has(text(state?.status))) pending.push(shop);
  }
  const progress = {
    total: shops.length,
    completed: shops.length - pending.length,
    inFlight: 0,
    taskIds: initial.taskIds,
    byStatus: Object.fromEntries(Object.entries(initial.byStatus).filter(([status]) => terminal.has(status))),
  };
  await setStatus({ phase: 'upload_cycle', generationId: generation.id, cycleId: id, skippedDownloads, progress });
  console.log(`[${now()}] UPLOAD_CYCLE_START cycle=${id} pending=${pending.length} skipped_downloads=${skippedDownloads} workers=${UPLOAD_WORKERS}`);
  await runPool(
    pending,
    UPLOAD_WORKERS,
    async shop => {
      progress.inFlight += 1;
      try { return await uploadOneStore(cycle, generation, shop); }
      finally { progress.inFlight -= 1; }
    },
    async result => {
      progress.completed += 1;
      const status = result.status === 'fulfilled' ? result.value.status : 'worker_error';
      progress.byStatus[status] = (progress.byStatus[status] ?? 0) + 1;
      if (result.status === 'fulfilled' && result.value.newTaskId) progress.taskIds += 1;
      await setStatus({ phase: 'upload_cycle', generationId: generation.id, cycleId: id, skippedDownloads, progress: { ...progress, byStatus: { ...progress.byStatus } } });
    },
  );
  ensureNotStopping();
  const summary = await summarizeCycle(cycle, shops);
  cycle.status = 'completed';
  cycle.completedAt = now();
  cycle.byStatus = summary.byStatus;
  cycle.taskIds = summary.taskIds;
  await atomicWriteJson(cycleMetaPath(id), cycle);
  delete control.currentCycleId;
  control.lastCycleId = id;
  control.lastCycleStartedAt = cycle.startedAt;
  control.lastCycleCompletedAt = cycle.completedAt;
  control.nextUploadAt = new Date(Math.max(Date.now(), parseDate(cycle.startedAt) + UPLOAD_INTERVAL_MS)).toISOString();
  await atomicWriteJson(CONTROL_PATH, control);
  await setStatus({ phase: 'upload_cycle_complete', generationId: generation.id, cycleId: id, skippedDownloads, progress: { total: shops.length, completed: shops.length, inFlight: 0, taskIds: summary.taskIds, byStatus: summary.byStatus }, nextUploadAt: control.nextUploadAt });
  console.log(`[${now()}] UPLOAD_CYCLE_DONE cycle=${id} task_ids=${summary.taskIds} next=${control.nextUploadAt}`);
  return control;
}

async function waitUntil(timestamp, phase, extra = {}) {
  for (;;) {
    ensureNotStopping();
    const waitMs = parseDate(timestamp) - Date.now();
    if (waitMs <= 0) return;
    await setStatus({ phase, nextUploadAt: timestamp, ...extra });
    await sleep(Math.min(waitMs, 60_000));
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
async function acquireOwnedLock(file) {
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      try { await handle.writeFile(json({ pid: process.pid, host: lockHost, token: lockToken, runner: RUNNER_PATH, startedAt: now() })); }
      finally { await handle.close(); }
      acquiredLocks.push(file);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readJsonIfExists(file).catch(() => undefined);
      if (existing?.host === lockHost && isProcessAlive(Number(existing?.pid))) {
        throw new Error(`Another runner owns ${path.basename(file)} (PID ${existing.pid})`);
      }
      if (existing?.host !== lockHost) {
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
          throw new Error(`Another runner owns ${path.basename(file)} on a different host`);
        }
      }
      const renamed = `${file}.stale-${Date.now()}`;
      await fs.rename(file, renamed).catch(renameError => {
        if (renameError?.code !== 'ENOENT') throw renameError;
      });
    }
  }
}
function releaseLocksSync() {
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  for (const file of [...acquiredLocks].reverse()) {
    try {
      const current = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      if (current.token === lockToken && Number(current.pid) === process.pid) fsSync.unlinkSync(file);
    } catch { /* Never remove a missing or foreign lock. */ }
  }
}

async function offlineValidation() {
  const hashes = {};
  for (const [name, file] of Object.entries(HELPERS)) hashes[name] = sha256(await fs.readFile(file));
  const legacy = validateInventory(await readGzipJsonIfExists(LEGACY_INVENTORY_PATH));
  if (DOWNLOAD_WORKERS !== 20 || UPLOAD_WORKERS !== 10 || WEEK_MS !== 604_800_000 || UPLOAD_INTERVAL_MS !== 7_200_000) {
    throw new Error('Fixed schedule constants changed');
  }
  if (MERGE_POLICY !== 1 || UPLOAD_ENDPOINT !== 'uploadGrocery') throw new Error('Mutable endpoint contract changed');
  if (SELF_TEST) {
    const sample = {
      menus: [{ app_menu_id: 'menu', menu_name: 'Menu', app_category_ids: ['old'] }],
      categories: [{ app_category_id: 'old', category_name: 'Old', app_item_ids: ['a', 'b'] }],
      items: [
        { upc: '1', app_item_id: 'a', price: 100, item_name: 'A', status: 2 },
        { upc: '2', app_item_id: 'b', price: 200, item_name: 'B', status: 1 },
      ],
    };
    const built = buildCrossCopyPayload(sample);
    if (built.changed2To1 !== 1 || built.already1 !== 1 || built.payload.items.some(item => item.status !== 1)) {
      throw new Error('CrossCopy status normalization self-test failed');
    }
    validateCachedCrossCopyPayload(built.payload);
    let active = 0;
    let max = 0;
    const results = await runPool(Array.from({ length: 41 }, (_, index) => index), DOWNLOAD_WORKERS, async value => {
      active += 1;
      max = Math.max(max, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return value;
    });
    if (max !== 20 || results.some(entry => entry.status !== 'fulfilled')) throw new Error('20-worker pool self-test failed');
  }
  console.log(json({ ok: true, mode: 'offline-validation', policyVersion: POLICY_VERSION, inventoryStores: legacy.total, constants: { downloadWorkers: DOWNLOAD_WORKERS, uploadWorkers: UPLOAD_WORKERS, inventoryTtlDays: 7, menuTtlDays: 7, uploadIntervalHours: 2, uploadEndpoint: UPLOAD_ENDPOINT, mergePolicy: MERGE_POLICY }, helperSha256: hashes, apiCalls, filesystemWrites }));
}

if (STATUS_ONLY) {
  const status = await readJsonIfExists(STATUS_PATH);
  const control = await readJsonIfExists(CONTROL_PATH);
  console.log(json({ running: (await readJsonIfExists(LOCK_PATHS.at(-1)))?.pid ?? null, status: status ?? null, control: control ?? null }));
  process.exit(0);
}
if (VALIDATE_ONLY) {
  await offlineValidation();
  process.exit(0);
}
if (AUTH_TEST) {
  const appShopId = text(process.env.DIDI_NETO_AUTH_TEST_SHOP_ID);
  if (!/^\d+$/.test(appShopId)) throw new Error('DIDI_NETO_AUTH_TEST_SHOP_ID must be a numeric app_shop_id');
  try {
    await getShopToken(appShopId);
    console.log(json({ ok: true, mode: 'auth-test', appShopId, tokenObtained: true, apiCalls, filesystemWrites }));
    process.exit(0);
  } catch (error) {
    console.error(`Auth test failed: ${publicError(error)}`);
    process.exit(1);
  }
}

for (const directory of [DATA_ROOT, GENERATIONS_DIR, CYCLES_DIR]) await fs.mkdir(directory, { recursive: true });
process.on('exit', releaseLocksSync);
for (const file of LOCK_PATHS) await acquireOwnedLock(file);
lockHeartbeat = setInterval(async () => {
  const stamp = new Date();
  for (const file of acquiredLocks) {
    try { await fs.utimes(file, stamp, stamp); } catch { /* Lock loss is handled on the next run. */ }
  }
}, 20_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signalCount += 1;
    if (signalCount > 1) process.exit(signal === 'SIGINT' ? 130 : 143);
    stopRequested = true;
    console.log(`[${now()}] STOP_REQUESTED signal=${signal}; the current safe checkpoint will finish first`);
  });
}

let exitCode = 0;
try {
  console.log(`[${now()}] WEEKLY_DAEMON_START pid=${process.pid} download_workers=${DOWNLOAD_WORKERS} upload_workers=${UPLOAD_WORKERS} upload_every_hours=2`);
  let control = await readJsonIfExists(CONTROL_PATH) ?? {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    appId: APP_ID,
    createdAt: now(),
  };
  if (control.policyVersion !== POLICY_VERSION || control.appId !== APP_ID) throw new Error('Daemon checkpoint identity mismatch');
  for (;;) {
    ensureNotStopping();
    const inventory = await ensureInventory();
    const active = await ensureFreshGeneration(control, inventory);
    control = active.control;
    const currentGeneration = active.generation;
    const generationInventory = active.inventory;
    if (control.currentCycleId) {
      control = await runUploadCycle(control, currentGeneration, generationInventory);
      continue;
    }
    const nextAt = text(control.nextUploadAt) || now();
    await waitUntil(nextAt, 'waiting_for_upload', { generationId: currentGeneration.id });
    control = await runUploadCycle(control, currentGeneration, generationInventory);
  }
} catch (error) {
  if (stopRequested && publicError(error) === 'Graceful stop requested') {
    await setStatus({ phase: 'stopped', stoppedAt: now() });
    console.log(`[${now()}] WEEKLY_DAEMON_STOPPED`);
  } else {
    exitCode = 1;
    await setStatus({ phase: 'fatal', fatalError: publicError(error), failedAt: now() }).catch(() => undefined);
    console.error(`[${now()}] FATAL ${publicError(error)}`);
  }
} finally {
  await statusWriteTail.catch(() => undefined);
  releaseLocksSync();
}
process.exitCode = exitCode;
