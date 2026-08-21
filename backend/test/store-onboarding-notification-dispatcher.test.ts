import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StoreOnboardingNotificationFrequency } from '@prisma/client';
import {
  canAppendStoreOnboardingDeliveryBody,
  canonicalStoreOnboardingEventType,
  freezeStoreOnboardingDeliveryGroup,
  limitStoreOnboardingDeliveryText,
  nextStoreOnboardingScheduledAt,
  parseStoreOnboardingRetryAfter,
  renderStoreOnboardingTemplate,
  StoreOnboardingNotificationDispatcherService,
  storeOnboardingDeliveryTiming,
  storeOnboardingRetryDecision,
} from '../src/store-onboarding/store-onboarding-notification-dispatcher.service';

test('notification event taxonomy normalizes durable lifecycle events', () => {
  assert.equal(canonicalStoreOnboardingEventType('store_onboarding.enrolled', {}), 'request.enrolled');
  assert.equal(canonicalStoreOnboardingEventType('store_onboarding.configuration_brief.published', {}), 'configuration.brief_published');
  assert.equal(canonicalStoreOnboardingEventType('store_onboarding.stage.changed', { toStage: 'audit_rejected' }), 'audit.rejected');
  assert.equal(canonicalStoreOnboardingEventType('process.changed', {}), 'process.changed');
});

test('notification renderer resolves only the fixed context shape', () => {
  const rendered = renderStoreOnboardingTemplate(
    '{{ brand.name }} · {{ event.type }} · {{ stores.total }} · {{ event.unknown }}',
    {
      event: { type: 'audit.approved', occurredAt: '2026-08-21T10:00:00.000Z', actorName: 'Commercial', note: '' },
      request: { id: 'request-1', status: 'active', stage: 'audit_approved', url: '/request-1' },
      task: { id: 'task-1', name: 'Create Stores', url: '/task-1' },
      brand: { id: 'brand-1', name: 'Brand Demo', country: 'MX', kaType: 'KA' },
      stores: { total: 3, completed: 0, failed: 0 },
      store: { shopId: '', appShopId: '', status: 'audit_approved' },
      audit: { status: 'approved' },
      rtbo: { status: 'pending' },
      rollout: { country: 'MX', kaType: 'KA', workflowVersion: 'v1' },
    },
  );
  assert.equal(rendered, 'Brand Demo · audit.approved · 3 · —');
});

test('digest, scheduled and critical timing are deterministic', () => {
  const occurredAt = new Date('2026-08-21T12:07:00.000Z');
  const digest = storeOnboardingDeliveryTiming({
    frequency: StoreOnboardingNotificationFrequency.digest,
    intervalMinutes: 15,
    scheduledTime: null,
    timezone: 'America/Mexico_City',
    critical: false,
    occurredAt,
  });
  assert.equal(digest.dueAt.toISOString(), '2026-08-21T12:15:00.000Z');

  const scheduled = nextStoreOnboardingScheduledAt(
    new Date('2026-08-21T14:59:30.000Z'),
    '09:00',
    'America/Mexico_City',
  );
  assert.equal(scheduled.toISOString(), '2026-08-21T15:00:00.000Z');

  const critical = storeOnboardingDeliveryTiming({
    frequency: StoreOnboardingNotificationFrequency.scheduled,
    intervalMinutes: null,
    scheduledTime: '09:00',
    timezone: 'America/Mexico_City',
    critical: true,
    occurredAt,
  });
  assert.equal(critical.dueAt.toISOString(), occurredAt.toISOString());
});

test('delivery retry policy retries transient failures but not permanent 4xx', () => {
  assert.deepEqual(storeOnboardingRetryDecision(null, 1), { retry: true, delayMs: 30_000 });
  assert.deepEqual(storeOnboardingRetryDecision(429, 2), { retry: true, delayMs: 120_000 });
  assert.equal(storeOnboardingRetryDecision(503, 8).retry, false);
  assert.equal(storeOnboardingRetryDecision(400, 1).retry, false);
  assert.equal(parseStoreOnboardingRetryAfter('120'), 120_000);
  assert.equal(
    parseStoreOnboardingRetryAfter('Fri, 21 Aug 2026 12:02:00 GMT', Date.parse('2026-08-21T12:00:00Z')),
    120_000,
  );
});

test('delivery bundle keys are stable across retries and isolate late arrivals', () => {
  const first = freezeStoreOnboardingDeliveryGroup('profile:request:digest', ['delivery-b', 'delivery-a']);
  assert.match(first, /^profile:request:digest::bundle:[a-f0-9]{64}$/);
  assert.equal(freezeStoreOnboardingDeliveryGroup(first, ['delivery-a', 'delivery-b']), first);
  assert.notEqual(
    freezeStoreOnboardingDeliveryGroup('profile:request:digest', ['delivery-a', 'delivery-b', 'delivery-c']),
    first,
  );
});

test('an oversized individual notification is capped and isolated from later digest events', () => {
  const oversized = 'A'.repeat(20_000);
  assert.equal(canAppendStoreOnboardingDeliveryBody([], oversized), true);
  assert.equal(canAppendStoreOnboardingDeliveryBody([oversized], 'next event'), false);
  const rendered = limitStoreOnboardingDeliveryText([oversized]);
  assert.equal(rendered.length, 18_000);
  assert.match(rendered, /Mensaje truncado; consulte Guaro para ver el detalle completo\.$/);
});

test('dispatcher is a no-op before both master switches are enabled', async () => {
  let transactionCalls = 0;
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: false, notificationsEnabled: false }),
    },
    $transaction: async () => {
      transactionCalls++;
      throw new Error('transaction must not run while OFF');
    },
  };
  const dispatcher = new StoreOnboardingNotificationDispatcherService(prisma as never);
  assert.equal(await dispatcher.expandOutboxBatch(), 0);
  assert.equal(await dispatcher.deliverDueBatch(), 0);
  assert.equal(transactionCalls, 0);
});

test('delivery uses a stable idempotency header and treats only 2xx as success', async () => {
  const finalUpdates: unknown[] = [];
  let rawCall = 0;
  const claimed = {
    id: '11111111-1111-4111-8111-111111111111',
    renderedBody: 'Cambio confirmado',
    attemptCount: 1,
    groupKey: '',
    createdAt: new Date('2026-08-21T10:00:00.000Z'),
    outboxEvent: { id: 'event-1', eventKey: 'transition:event-1' },
    profileRevision: {
      logicalKey: 'mx-ka',
      webhook: { url: 'https://example.test/webhook-secret' },
    },
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      rawCall++;
      if (rawCall === 1) return [{ groupKey: 'profile:request:immediate' }];
      if (rawCall === 2) return [{ locked: true }];
      return [{ id: claimed.id }];
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async (args: { data?: { groupKey?: string; status?: string } }) => {
        if (args.data?.groupKey) claimed.groupKey = args.data.groupKey;
        if (args.data?.status && args.data.status !== 'processing') finalUpdates.push(args);
        return { count: 1 };
      },
      findMany: async () => [claimed],
    },
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: true }),
    },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({ enabled: true }),
    },
  };
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: true }),
    },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({ enabled: true }),
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async (args: unknown) => {
        finalUpdates.push(args);
        return { count: 1 };
      },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const previousFetch = global.fetch;
  let sentHeaders: HeadersInit | undefined;
  let sentBody = '';
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentHeaders = init?.headers;
    sentBody = String(init?.body ?? '');
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { cancel: async () => { throw new Error('response stream already closed'); } },
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const dispatcher = new StoreOnboardingNotificationDispatcherService(prisma as never);
    assert.equal(await dispatcher.deliverDueBatch(), 1);
  } finally {
    global.fetch = previousFetch;
  }
  const headers = new Headers(sentHeaders);
  assert.match(headers.get('Idempotency-Key') ?? '', /^[a-f0-9]{64}$/);
  assert.equal(headers.get('X-Guaro-Event-Id'), 'transition:event-1');
  assert.deepEqual(JSON.parse(sentBody), { text: 'Cambio confirmado' });
  assert.equal((finalUpdates.at(-1) as { data: { status: string } }).data.status, 'delivered');
});

async function exerciseFailedDelivery(status: number, retryAfter?: string) {
  const finalUpdates: Array<{ data: { status: string; nextAttemptAt?: Date; responseStatus?: number } }> = [];
  let rawCall = 0;
  const claimed = {
    id: '22222222-2222-4222-8222-222222222222',
    renderedBody: 'Cambio confirmado',
    attemptCount: 1,
    groupKey: '',
    createdAt: new Date('2026-08-21T10:00:00.000Z'),
    outboxEvent: { id: 'event-2', eventKey: 'transition:event-2' },
    profileRevision: {
      logicalKey: 'mx-ka',
      webhook: { url: 'https://example.test/webhook-secret' },
    },
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      rawCall++;
      if (rawCall === 1) return [{ groupKey: 'profile:request:digest' }];
      if (rawCall === 2) return [{ locked: true }];
      return [{ id: claimed.id }];
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async (args: { data?: { groupKey?: string; status?: string } }) => {
        if (args.data?.groupKey) claimed.groupKey = args.data.groupKey;
        if (args.data?.status && args.data.status !== 'processing') {
          finalUpdates.push(args as { data: { status: string; nextAttemptAt?: Date; responseStatus?: number } });
        }
        return { count: 1 };
      },
      findMany: async () => [claimed],
    },
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: true }),
    },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({ enabled: true }),
    },
  };
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: true }),
    },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({ enabled: true }),
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async (args: { data: { status: string; nextAttemptAt?: Date; responseStatus?: number } }) => {
        finalUpdates.push(args);
        return { count: 1 };
      },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const previousFetch = global.fetch;
  global.fetch = (async () => new Response('', {
    status,
    headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
  })) as typeof fetch;
  try {
    const dispatcher = new StoreOnboardingNotificationDispatcherService(prisma as never);
    assert.equal(await dispatcher.deliverDueBatch(), 1);
  } finally {
    global.fetch = previousFetch;
  }
  return finalUpdates.at(-1)!.data;
}

test('HTTP 429 schedules a durable retry and honors Retry-After', async () => {
  const before = Date.now();
  const result = await exerciseFailedDelivery(429, '180');
  assert.equal(result.status, 'retry_wait');
  assert.equal(result.responseStatus, 429);
  assert.ok(result.nextAttemptAt instanceof Date);
  assert.ok(result.nextAttemptAt!.getTime() >= before + 180_000);
});

test('permanent HTTP 400 moves the delivery to failed without retrying', async () => {
  const result = await exerciseFailedDelivery(400);
  assert.equal(result.status, 'failed');
  assert.equal(result.responseStatus, 400);
  assert.equal(result.nextAttemptAt, undefined);
});

test('a master disable committed after claim suppresses the bundle before HTTP', async () => {
  let transactionCall = 0;
  let rawCall = 0;
  let fetchCalls = 0;
  const finalStatuses: string[] = [];
  const claimed = {
    id: '33333333-3333-4333-8333-333333333333',
    renderedBody: 'No debe enviarse',
    attemptCount: 1,
    groupKey: 'profile:request::bundle:stable',
    createdAt: new Date(),
    outboxEvent: { id: 'event-3', eventKey: 'transition:event-3' },
    profileRevision: { logicalKey: 'mx-ka', webhook: { url: 'https://example.test/secret' } },
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      rawCall++;
      if (rawCall === 1) return [{ groupKey: 'profile:request' }];
      if (rawCall === 2) return [{ locked: true }];
      return [{ id: claimed.id, renderedBody: claimed.renderedBody }];
    },
    storeOnboardingControl: {
      findUnique: async () => transactionCall === 1
        ? { globalEnabled: true, notificationsEnabled: true }
        : { globalEnabled: false, notificationsEnabled: false },
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async (args: { data?: { groupKey?: string; status?: string } }) => {
        if (args.data?.groupKey) claimed.groupKey = args.data.groupKey;
        if (args.data?.status && args.data.status !== 'processing') finalStatuses.push(args.data.status);
        return { count: 1 };
      },
      findMany: async () => [claimed],
    },
  };
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: true, notificationsEnabled: true }),
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => {
      transactionCall++;
      return callback(tx);
    },
  };
  const previousFetch = global.fetch;
  global.fetch = (async () => {
    fetchCalls++;
    return new Response('', { status: 200 });
  }) as typeof fetch;
  try {
    const dispatcher = new StoreOnboardingNotificationDispatcherService(prisma as never);
    assert.equal(await dispatcher.deliverDueBatch(), 1);
  } finally {
    global.fetch = previousFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual(finalStatuses, ['suppressed']);
});

test('lease recovery rechecks the shared master fence and performs no writes while OFF', async () => {
  let rootReads = 0;
  let leaseWrites = 0;
  const tx = {
    $executeRaw: async () => 1,
    storeOnboardingControl: {
      findUnique: async () => ({ globalEnabled: false, notificationsEnabled: false }),
    },
    storeOnboardingOutboxEvent: { updateMany: async () => { leaseWrites++; } },
    storeOnboardingNotificationDelivery: { updateMany: async () => { leaseWrites++; } },
  };
  const prisma = {
    storeOnboardingControl: {
      findUnique: async () => {
        rootReads++;
        return rootReads === 1
          ? { globalEnabled: true, notificationsEnabled: true }
          : { globalEnabled: false, notificationsEnabled: false };
      },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const dispatcher = new StoreOnboardingNotificationDispatcherService(prisma as never);
  await dispatcher.poll();
  assert.equal(leaseWrites, 0);
});
