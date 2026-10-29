import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { CompletionRateOrderService, parseLifecycle } from '../src/didi-order-webhooks/completion-rate-order.service';
import { CompletionRateService } from '../src/integrations/completion-rate.service';
import { classifyOrder, evaluateRate, monitoringWindow } from '../src/integrations/completion-rate.util';
import { DidiOrderWebhooksService } from '../src/didi-order-webhooks/didi-order-webhooks.service';

const appId = '5764607654490537991';
const orderId = '9223372036854775807';
const second = 1793102400;
const event = (type: string, status?: number, timestamp = second) => ({ type, app_id: appId, app_shop_id: 'store-1', timestamp: String(timestamp), data: { order_id: orderId, delivery_status: status,
  ...(type === 'orderNew' ? { order_info: { order_id: orderId, create_time: String(second - 600), shop: { app_shop_id: 'store-1', shop_id: '123' } } } : {}) } });

test('Mexico monitoring boundaries include 06:00 and 03:00 but exclude the overnight pause', () => {
  for (const [time, active] of [['05:59:00', false], ['06:00:00', true], ['23:45:00', true], ['00:00:00', true], ['02:45:00', true], ['03:00:00', true], ['03:15:00', false], ['04:00:00', false]] as const) {
    assert.equal(!!monitoringWindow(new Date(`2026-10-28T${time}-06:00`)), active, time);
  }
  assert.equal(monitoringWindow(new Date('2026-10-28T13:07:44-06:00'))!.toISOString(), '2026-10-28T19:00:00.000Z');
});

test('CR uses completed plus eligible cancellations, exact threshold and minimum volume', () => {
  assert.deepEqual(evaluateRate(0, 0, 10, 15, 10), { total: 0, completionRate: null, alert: false });
  assert.equal(evaluateRate(3, 6, 10, 15, 10).alert, false);
  assert.equal(evaluateRate(15, 5, 10, 15, 10).alert, true);
  assert.equal(evaluateRate(16, 4, 10, 15, 10).alert, false);
  assert.equal(evaluateRate(2, 1, 10, 15, 4).completionRate, null);
  assert.equal(evaluateRate(15, 5, 20, 15, 10).alert, false);
});

test('cancellation rules match grocery_tools including the five minute boundary', () => {
  const order = { createdTime: new Date(0), terminalTime: new Date(300_000), status: 901 };
  assert.equal(classifyOrder(order), 'cancelled');
  assert.equal(classifyOrder({ ...order, terminalTime: new Date(299_999) }), 'excluded');
  assert.equal(classifyOrder({ ...order, createdTime: null }), 'unknown');
  for (const status of [902, 921, 922, 923, 961, 971, 981]) assert.equal(classifyOrder({ ...order, status }), 'cancelled');
  for (const status of [160, 600]) assert.equal(classifyOrder({ ...order, status }), 'completed');
  assert.equal(classifyOrder({ ...order, status: 170 }), 'unknown');
});

test('lifecycle parsing retains int64 identifiers and validates application, timestamp and state', () => {
  assert.equal(parseLifecycle(event('deliveryStatus', 160), appId).orderId, orderId);
  assert.equal(parseLifecycle(event('orderCancel'), appId).status, 170);
  assert.throws(() => parseLifecycle(event('deliveryStatus', 160), '999'));
  assert.throws(() => parseLifecycle(event('deliveryStatus', 777), appId));
  assert.throws(() => parseLifecycle({ ...event('orderCancel'), timestamp: 'NaN' }, appId));
});

test('duplicate and out-of-order deliveries keep one order and preserve terminal state', async () => {
  let stored: any = null;
  const tx = { $executeRaw: async () => 1, completionRateOrder: {
    findUnique: async () => stored,
    create: async ({ data }: any) => { stored = { ...data }; },
    update: async ({ data }: any) => { stored = { ...stored, ...data }; },
  } };
  const service = new CompletionRateOrderService({ $transaction: (fn: any) => fn(tx) } as any);
  await service.record('app', appId, event('deliveryStatus', 600));
  await service.record('app', appId, event('orderNew', undefined, second - 300));
  await service.record('app', appId, event('deliveryStatus', 130, second - 100));
  await service.record('app', appId, event('deliveryStatus', 600));
  assert.equal(stored.status, 600);
  assert.equal(stored.createdTime.getTime(), (second - 600) * 1000);
  assert.equal(stored.terminalTime.getTime(), second * 1000);
  await assert.rejects(() => service.record('app', appId, { ...event('orderCancel'), app_shop_id: 'other-store' }));
});

const config = new ConfigService({ DCHAT_URL: 'https://dchat.example.test/group/', DCHAT_GROUP_ID: 'common', APP_SECRET_ENCRYPTION_KEY: '42'.repeat(32) });
const dto = { crAlertsEnabled: true, crBaselineCancelRate: 10, crDeviationPoints: 15, crMinOrders: 10 };
test('configuration requires an existing active application webhook and shared D-Chat destination', async () => {
  const brand: any = { application: null };
  let writes = 0;
  const prisma: any = { brand: { findFirst: async () => brand, update: async () => { writes++; } } };
  const service = new CompletionRateService(prisma, config);
  await assert.rejects(() => service.update('brand', dto));
  brand.application = { orderWebhookCreatedAt: new Date(), orderWebhookTokenHash: 'hash', deletedAt: null, orderWebhookDisabledAt: new Date() };
  await assert.rejects(() => service.update('brand', dto));
  brand.application.orderWebhookDisabledAt = null;
  await service.update('brand', dto);
  assert.equal(writes, 1);
  await assert.rejects(() => new CompletionRateService(prisma, new ConfigService()).update('brand', dto));
  await assert.rejects(() => service.update('brand', { ...dto, crBaselineCancelRate: 90 }));
});

test('monitoring isolates application and brand shops, uses half-open windows and deduplicates runs', async () => {
  const end = new Date('2026-10-28T12:15:00Z');
  const brand = { id: 'brand', brandName: 'Brand', applicationId: 'app', ...dto, shops: [{ appShopId: 'store-1', shopId: '123', name: 'Store' }] };
  const created: any[] = [];
  let queried: any;
  const prisma: any = { brand: { findMany: async () => [brand] }, completionRateOrder: { findMany: async (query: any) => {
    queried = query;
    return Array.from({ length: 10 }, (_, i) => ({ orderId: String(i), appShopId: 'store-1', status: i < 7 ? 600 : 921 }));
  } }, completionRateRun: { findUnique: async () => created[0] ?? null, create: async ({ data }: any) => { created.push(data); } } };
  const service = new CompletionRateService(prisma, config);
  await service.evaluate(end);
  await service.evaluate(end);
  assert.equal(created.length, 1);
  assert.equal(created[0].completionRate, 70);
  assert.equal(created[0].status, 'pending');
  assert.match(created[0].message, /Store \(store-1\)/);
  assert.equal(queried.where.applicationId, 'app');
  assert.deepEqual(queried.where.OR[0], { appShopId: { in: ['store-1'] } });
  assert.equal(queried.where.terminalTime.gte.toISOString(), '2026-10-28T12:00:00.000Z');
  assert.equal(queried.where.terminalTime.lt, end);
});

test('D-Chat deliveries are claimed before sending and failures remain retryable', async () => {
  const originalFetch = global.fetch;
  let messages = 0;
  const updates: any[] = [];
  const run: any = { id: 'run', status: 'pending', attempts: 0, message: 'Alert' };
  const prisma: any = { completionRateRun: {
    findMany: async () => [run],
    updateMany: async ({ where, data }: any) => {
      if (!where.id) return { count: 0 };
      if (run.status !== where.status || run.attempts !== where.attempts) return { count: 0 };
      run.status = data.status; run.attempts++; return { count: 1 };
    },
    update: async ({ data }: any) => { updates.push(data); Object.assign(run, data); },
  } };
  try {
    global.fetch = async (_url, options) => {
      assert.equal(run.status, 'sending');
      assert.deepEqual(JSON.parse(String(options?.body)), { text: 'Alert' });
      messages++; return new Response('', { status: messages === 1 ? 503 : 200 });
    };
    const service = new CompletionRateService(prisma, config);
    await service.deliver();
    assert.equal(updates[0].status, 'failed');
    await service.deliver();
    assert.equal(updates[1].status, 'sent');
    assert.equal(messages, 2);
  } finally { global.fetch = originalFetch; }
});

test('existing authenticated endpoint routes lifecycle events without order confirmation or forwarding', async () => {
  let captured: any;
  const prisma: any = { application: { findFirst: async () => ({ id: 'app', appId }) }, didiOrderWebhookRequest: {
    create: async () => ({ id: 'request' }), update: async () => ({}),
  } };
  const service = new DidiOrderWebhooksService(prisma, config, undefined, { persist: async () => { throw new Error('Should not forward'); } } as any,
    { record: async (...args: any[]) => { captured = args; } } as any);
  assert.deepEqual(await service.receive('A'.repeat(43), Buffer.from(JSON.stringify(event('deliveryStatus', 600)))), { errno: 0, errmsg: 'ok' });
  assert.equal(captured[0], 'app');
  assert.equal(captured[2].type, 'deliveryStatus');
});
