import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { encrypt } from '../src/common/crypto.util';
import { StoreCrService, summarizeStoreOrders } from '../src/integrations/store-cr.service';
import { operationalDay, storeCrDecision, closureDestination, isCrClosureConflict } from '../src/integrations/store-cr.util';
import { StoreOpeningGuardService } from '../src/integrations/store-opening-guard.service';
import { CompletionRateService } from '../src/integrations/completion-rate.service';
import { validate } from 'class-validator';
import { UpdateCompletionRateDto } from '../src/integrations/dto/update-completion-rate.dto';

const KEY = '42'.repeat(32);
const NOW = new Date('2026-10-29T18:00:00Z');
const config = new ConfigService({ APP_SECRET_ENCRYPTION_KEY: KEY, DCHAT_URL: 'https://dchat.example.test/', DCHAT_GROUP_ID: 'alerts', DCHAT_STORE_CLOSURE_GROUP_ID: 'closures' });
function clock() {
  const OriginalDate = Date;
  global.Date = class extends OriginalDate {
    constructor(value?: any) { super(value ?? NOW.getTime()); }
    static now() { return NOW.getTime(); }
  } as DateConstructor;
  return () => { global.Date = OriginalDate; };
}
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (value instanceof Date) return +row[key] === +value;
    if (value === null || typeof value !== 'object') return row[key] === value;
    if (value.in && !value.in.includes(row[key])) return false;
    if ('lt' in value && !(row[key] < value.lt)) return false;
    if ('lte' in value && !(row[key] <= value.lte)) return false;
    if ('gt' in value && !(row[key] > value.gt)) return false;
    if ('gte' in value && !(row[key] >= value.gte)) return false;
    return true;
  });
}
function harness(initialStatus = 'pending') {
  const row: any = { id: 'closure', brandId: 'brand', shopId: 'shop', applicationId: 'app', appShopId: 's1', brandName: 'Brand', shopName: 'Shop',
    operationalStart: new Date('2026-10-29T10:00:00Z'), blockedUntil: new Date('2026-10-30T10:00:00Z'), evaluatedAt: NOW,
    completionRate: 0, threshold: 50, minOrders: 3, completed: 0, cancelled: 3, attempts: 0, status: initialStatus,
    notificationStatus: 'waiting', notificationAttempts: 0, updatedAt: NOW, createdAt: NOW, closedAt: null };
  const brand: any = { id: 'brand', brandName: 'Brand', country: 'MX', applicationId: 'app', crAutoClosureEnabled: true, crAutoClosureThreshold: 50, crAutoClosureMinOrders: 3 };
  const shop: any = { id: 'shop', appShopId: 's1', shopId: '123', brandId: 'brand', name: 'Shop', brand };
  const app = { id: 'app', appId: '123', appSecret: encrypt('secret', KEY) };
  let orders: any[] = [0, 1, 2].map(i => ({ orderId: String(i), appShopId: 's1', status: 921, createdTime: new Date('2026-10-29T15:00:00Z'), terminalTime: new Date('2026-10-29T17:00:00Z') }));
  let rollback = false;
  const writes: any[] = [];
  function update(data: any) {
    for (const [key, value] of Object.entries(data)) row[key] = typeof value === 'object' && value !== null && 'increment' in value ? row[key] + (value as any).increment : value;
    return { ...row };
  }
  const prisma: any = {
    $executeRaw: async () => 1,
    application: { findFirst: async () => app },
    shop: { findFirst: async () => brand.crAutoClosureEnabled ? shop : null },
    completionRateOrder: { findMany: async () => orders },
    storeCrClosure: {
      findUnique: async () => ({ ...row }),
      findFirst: async ({ where }: any) => matches(row, where) ? { ...row } : null,
      findMany: async ({ where }: any) => matches(row, where) ? [{ ...row }] : [],
      update: async ({ data }: any) => update(data),
      updateMany: async ({ where, data }: any) => { if (!matches(row, where)) return { count: 0 }; update(data); return { count: 1 }; },
    },
  };
  prisma.$transaction = async (fn: any) => {
    const before = structuredClone(row);
    try { const result = await fn(prisma); if (rollback) throw new Error('commit failed'); return result; }
    catch (error) { Object.assign(row, before); throw error; }
  };
  return { row, brand, shop, prisma, writes, service: new StoreCrService(prisma, config), failCommit: () => { rollback = true; }, setOrders: (value: any[]) => { orders = value; } };
}
function fakeDidi(h: ReturnType<typeof harness>, result: 'ok' | 'reject' | 'timeout' = 'ok') {
  return async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/authtoken/refresh')) return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'r' } }));
    if (url.includes('/authtoken/get')) return new Response(JSON.stringify({ errno: 0, data: { auth_token: 't' } }));
    h.writes.push({ url, body: JSON.parse(String(init?.body)) });
    if (result === 'timeout') throw new Error('timeout');
    return new Response(JSON.stringify({ errno: result === 'ok' ? 0 : 10001 }));
  };
}

test('operational day rolls at 04:00 locally, not midnight, for MX, CO and CR', () => {
  for (const country of ['MX', 'CR']) {
    assert.equal(operationalDay(country, new Date('2026-10-29T09:59:59Z')).start.toISOString(), '2026-10-28T10:00:00.000Z');
    assert.equal(operationalDay(country, new Date('2026-10-29T10:00:00Z')).end.toISOString(), '2026-10-30T10:00:00.000Z');
  }
  assert.equal(operationalDay('CO', new Date('2026-10-29T08:59:59Z')).start.toISOString(), '2026-10-28T09:00:00.000Z');
  assert.equal(operationalDay('CO', new Date('2026-10-29T09:00:00Z')).start.toISOString(), '2026-10-29T09:00:00.000Z');
});

test('static rule closes at the inclusive threshold and minimum; unknown data never closes', () => {
  assert.equal(storeCrDecision(1, 1, 0, 50, 3).reason, 'insufficient_orders');
  assert.equal(storeCrDecision(2, 2, 0, 50, 3).reason, 'closure_requested');
  assert.equal(storeCrDecision(3, 1, 0, 50, 3).reason, 'healthy');
  assert.equal(storeCrDecision(0, 3, 1, 50, 3).reason, 'incomplete');
  assert.equal(storeCrDecision(0, 0, 0, 50, 3).cr, null);
  assert.equal(storeCrDecision(0, 1, 0, 0, 1).reason, 'closure_requested');
});

test('store statistics reuse cancellation exclusions and preserve order IDs', () => {
  const base = { createdTime: new Date(0), terminalTime: new Date(300_000) };
  const stats = summarizeStoreOrders([
    { ...base, orderId: '9223372036854775807', status: 600 },
    { ...base, orderId: '2', status: 901 },
    { ...base, orderId: '3', status: 901, terminalTime: new Date(299_999) },
    { ...base, orderId: '4', status: 170 },
  ]);
  assert.deepEqual([stats.completed, stats.cancelled, stats.unknown], [1, 0, 1]);
  assert.deepEqual(stats.orderIds.cancelled, []);
  assert.deepEqual(stats.orderIds.unknown, ['4']);
  assert.deepEqual(stats.orderIds.completed, ['9223372036854775807']);
});

test('excluded cancellations cannot trigger a closure or satisfy its minimum volume', () => {
  const base = { createdTime: new Date(0), terminalTime: new Date(3600_000) };
  const excluded = Array.from({ length: 10 }, (_, i) => ({ ...base, orderId: `excluded-${i}`, status: 901 }));
  const completed = [{ ...base, orderId: 'finished', status: 600 }];
  const stats = summarizeStoreOrders([...completed, ...excluded]);
  assert.equal(storeCrDecision(stats.completed, stats.cancelled, stats.unknown, 50, 1).reason, 'healthy');
  assert.equal(storeCrDecision(stats.completed, stats.cancelled, stats.unknown, 50, 3).reason, 'insufficient_orders');
  const eligible = summarizeStoreOrders([902, 921, 922, 923, 961, 971, 981].map(status => ({ ...base, orderId: String(status), status })));
  assert.equal(eligible.cancelled, 7);
  assert.equal(storeCrDecision(eligible.completed, eligible.cancelled, eligible.unknown, 50, 3).reason, 'closure_requested');
});

test('closure notification uses its own group and does not fall back to the alert group', () => {
  assert.equal(new StoreCrService({} as any, config).destination(), 'https://dchat.example.test/closures');
  assert.equal(new StoreCrService({} as any, new ConfigService({ DCHAT_URL: 'https://dchat.example.test/', DCHAT_GROUP_ID: 'alerts' })).destination(), null);
  assert.equal(closureDestination('http://example.test/', 'closures'), null);
});

test('closure inputs reject null, out-of-range thresholds and invalid minimum counts', async () => {
  const base = { crAlertsEnabled: false, crBaselineCancelRate: 10, crDeviationPoints: 15, crMinOrders: 10 };
  for (const extra of [{ crAutoClosureEnabled: null }, { crAutoClosureThreshold: null }, { crAutoClosureThreshold: -1 },
    { crAutoClosureThreshold: 101 }, { crAutoClosureMinOrders: 0 }, { crAutoClosureMinOrders: 1.5 }]) {
    assert.ok((await validate(Object.assign(new UpdateCompletionRateDto(), base, extra))).length);
  }
  assert.equal((await validate(Object.assign(new UpdateCompletionRateDto(), base, { crAutoClosureEnabled: true, crAutoClosureThreshold: 0, crAutoClosureMinOrders: 1 }))).length, 0);
});

test('pending closure from an expired operational day never sends OFF', async () => {
  const restore = clock(), originalFetch = global.fetch, h = harness();
  h.row.blockedUntil = NOW;
  global.fetch = fakeDidi(h);
  try {
    await h.service.processPending(NOW);
    assert.equal(h.row.status, 'expired');
    assert.equal(h.writes.length, 0);
  } finally { global.fetch = originalFetch; restore(); }
});

test('stale in-flight closure at the attempt limit becomes uncertain and schedules a truthful notification', async () => {
  const restore = clock(), h = harness('closing');
  h.row.updatedAt = new Date(NOW.getTime() - 121_000);
  h.row.attempts = 3;
  try {
    await h.service.processPending(NOW);
    assert.equal(h.row.status, 'unknown');
    assert.equal(h.row.notificationStatus, 'pending');
    assert.equal(h.writes.length, 0);
  } finally { restore(); }
});

test('DiDi is closed with the original static payload, only a successful response confirms it, and duplicates do not resend', async () => {
  const restore = clock(), originalFetch = global.fetch;
  const h = harness();
  global.fetch = fakeDidi(h);
  try {
    await Promise.all([h.service.close('closure'), h.service.close('closure')]);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].body, { auth_token: 't', biz_status: 2, auto_switch: 2 });
    assert.equal(h.row.status, 'closed');
    assert.ok(h.row.closedAt);
    assert.equal(h.row.notificationStatus, 'pending');
    await h.service.close('closure');
    assert.equal(h.writes.length, 1);
  } finally { global.fetch = originalFetch; restore(); }
});

test('provider rejection retries at most three times and never reports a confirmed closure', async () => {
  const restore = clock(), originalFetch = global.fetch, h = harness();
  global.fetch = fakeDidi(h, 'reject');
  try {
    for (let i = 0; i < 4; i++) await h.service.close('closure');
    assert.equal(h.writes.length, 3);
    assert.equal(h.row.status, 'failed');
    assert.equal(h.row.closedAt, null);
    assert.equal(h.row.notificationStatus, 'pending');
  } finally { global.fetch = originalFetch; restore(); }
});

test('ambiguous provider timeout remains protected and a later explicit rejection cannot erase that uncertainty', async () => {
  const restore = clock(), originalFetch = global.fetch, h = harness();
  global.fetch = fakeDidi(h, 'timeout');
  try {
    await h.service.close('closure');
    assert.equal(h.row.status, 'unknown');
    global.fetch = fakeDidi(h, 'reject');
    await h.service.close('closure');
    assert.equal(h.row.status, 'unknown');
    assert.equal(h.row.closedAt, null);
  } finally { global.fetch = originalFetch; restore(); }
});

test('a failed DB commit after provider acceptance records an uncertain outcome', async () => {
  const restore = clock(), originalFetch = global.fetch, h = harness();
  global.fetch = fakeDidi(h); h.failCommit();
  try {
    await h.service.close('closure');
    assert.equal(h.writes.length, 1);
    assert.equal(h.row.status, 'unknown');
    assert.equal(h.row.closedAt, null);
  } finally { global.fetch = originalFetch; restore(); }
});

test('configuration disabled, CR recovered, unresolved orders or a changed operational day prevents a provider write', async () => {
  const restore = clock(), originalFetch = global.fetch;
  try {
    for (const kind of ['disabled', 'recovered', 'incomplete', 'new-day']) {
      const h = harness(); global.fetch = fakeDidi(h);
      if (kind === 'disabled') h.brand.crAutoClosureEnabled = false;
      if (kind === 'recovered') h.setOrders([0, 1, 2].map(i => ({ orderId: String(i), status: 600 })));
      if (kind === 'incomplete') h.setOrders([{ orderId: '1', status: 170 }]);
      if (kind === 'new-day') h.row.operationalStart = new Date('2026-10-28T10:00:00Z');
      await h.service.close('closure');
      assert.equal(h.writes.length, 0, kind);
      assert.equal(h.row.status, 'suppressed', kind);
    }
  } finally { global.fetch = originalFetch; restore(); }
});

test('Auto Open permit blocks pending, confirmed and uncertain closures until the operational day ends', async () => {
  const restore = clock();
  let calls = 0;
  const closure: any = { shopId: 'shop', status: 'closed', blockedUntil: new Date('2026-10-30T10:00:00Z') };
  const tx: any = { $executeRaw: async () => 1, shop: { findUnique: async () => ({ id: 'shop', shopId: '123', brandId: 'brand' }) },
    storeEmergency: { findFirst: async () => null }, storeCrClosure: { findFirst: async ({ where }: any) => matches(closure, where) ? closure : null } };
  const guard = new StoreOpeningGuardService({ $transaction: (fn: any) => fn(tx) } as any);
  const permit = () => guard.withOpeningPermit({ shopId: 'shop', operation: 'auto_open', execute: async () => { calls++; } });
  try {
    for (const status of ['pending', 'closing', 'closed', 'unknown']) {
      closure.status = status;
      await assert.rejects(permit, error => isCrClosureConflict(error));
    }
    assert.equal(calls, 0);
    closure.blockedUntil = NOW;
    await permit();
    assert.equal(calls, 1, 'Auto Open can open when protection expires; closure service never opens');
  } finally { restore(); }
});

test('closure notification retries without reissuing the close and labels uncertain outcomes accurately', async () => {
  const restore = clock(), originalFetch = global.fetch, h = harness('unknown');
  h.row.notificationStatus = 'pending';
  let calls = 0;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://dchat.example.test/closures');
    assert.match(JSON.parse(String(init?.body)).text, /sin confirmar/);
    calls++;
    return new Response('', { status: calls === 1 ? 503 : 200 });
  };
  try {
    await h.service.notify(); assert.equal(h.row.notificationStatus, 'failed');
    await h.service.notify(); assert.equal(h.row.notificationStatus, 'sent');
    await h.service.notify(); assert.equal(calls, 2);
    assert.equal(h.row.attempts, 0);
  } finally { global.fetch = originalFetch; restore(); }
});

test('closure configuration can be enabled with brand alerts off, but requires the dedicated group', async () => {
  const brand: any = { crAutoClosureEnabled: false, application: { orderWebhookCreatedAt: NOW, orderWebhookTokenHash: 'hash' } };
  const prisma: any = { brand: { findFirst: async () => brand, update: async ({ data }: any) => Object.assign(brand, data) }, $executeRaw: async () => 1 };
  prisma.$transaction = (fn: any) => fn(prisma);
  const dto = { crAlertsEnabled: false, crBaselineCancelRate: 10, crDeviationPoints: 15, crMinOrders: 10, crAutoClosureEnabled: true, crAutoClosureThreshold: 50, crAutoClosureMinOrders: 3 };
  await assert.rejects(() => new CompletionRateService(prisma, new ConfigService()).update('brand', dto));
  await new CompletionRateService(prisma, config).update('brand', dto);
  assert.equal(brand.crAutoClosureEnabled, true);
  assert.equal(brand.crAlertsEnabled, false);
});

test('evaluation is per store over the operational day, isolated to the application and deduplicated for the day', async () => {
  const restore = clock();
  const shops = [{ id: 'good', shopId: '1', appShopId: 's1', name: 'Good' }, { id: 'bad', shopId: '2', appShopId: 's2', name: 'Bad' }];
  const brand = { id: 'brand', brandName: 'Brand', country: 'MX', applicationId: 'app', crAutoClosureThreshold: 50, crAutoClosureMinOrders: 3, shops };
  const decisions: any[] = [], closures: any[] = [];
  let query: any;
  const prisma: any = {
    $executeRaw: async () => 1,
    brand: { findMany: async () => [brand], findFirst: async () => brand },
    completionRateOrder: { findMany: async (args: any) => {
      query = args;
      return Array.from({ length: 6 }, (_, i) => ({ orderId: String(i), appShopId: i < 3 ? 's1' : 's2', status: i < 3 ? 600 : 921 }));
    } },
    storeCrDecision: { findMany: async ({ where }: any) => decisions.filter(d => +d.windowEnd === +where.windowEnd), create: async ({ data }: any) => decisions.push(data) },
    storeCrClosure: { findUnique: async ({ where }: any) => closures.find(c => c.shopId === where.shopId_operationalStart.shopId) ?? null, create: async ({ data }: any) => closures.push(data) },
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  try {
    const service = new StoreCrService(prisma, config);
    await service.evaluate(NOW);
    await service.evaluate(NOW);
    await service.evaluate(new Date(NOW.getTime() + 900_000));
    assert.equal(decisions.length, 4);
    assert.equal(closures.length, 1);
    assert.equal(closures[0].shopId, 'bad');
    assert.equal(decisions[0].reason, 'healthy');
    assert.equal(decisions[3].reason, 'already_requested_today');
    assert.equal(query.where.applicationId, 'app');
    assert.equal(query.where.terminalTime.gte.toISOString(), '2026-10-29T10:00:00.000Z');
    assert.ok(query.where.terminalTime.lt, 'half-open window does not count boundary orders twice');
    assert.equal(closures[0].blockedUntil.toISOString(), '2026-10-30T10:00:00.000Z');
  } finally { restore(); }
});
