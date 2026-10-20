import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { ApplicationsService } from '../src/applications/applications.service';
import { decrypt, encrypt } from '../src/common/crypto.util';
import { DidiOrderForwardingProcessor } from '../src/didi-order-webhooks/didi-order-forwarding.processor';
import { DidiOrderForwardingService } from '../src/didi-order-webhooks/didi-order-forwarding.service';
import {
  isPrivateOrLocalAddress,
  validateForwardingUrl,
} from '../src/didi-order-webhooks/didi-order-forwarding-url.util';

const KEY = '24'.repeat(32);

test('production forwarding URLs reject unsafe destinations and non-production permits local smoke URLs', () => {
  assert.throws(() => validateForwardingUrl('http://example.com/hook', true), /HTTPS/);
  assert.throws(() => validateForwardingUrl('https://user:pass@example.com/hook', true), /credentials/);
  assert.throws(() => validateForwardingUrl('https://example.com/hook#secret', true), /fragment/);
  assert.throws(() => validateForwardingUrl('https://localhost/hook', true), /not allowed/);
  assert.throws(() => validateForwardingUrl('https://127.0.0.1/hook', true), /not allowed/);
  assert.throws(() => validateForwardingUrl('https://[::1]/hook', true), /not allowed/);
  assert.throws(() => validateForwardingUrl('https://openapi.didi-food.com/hook', true), /not allowed/);
  assert.equal(
    validateForwardingUrl('http://127.0.0.1:4567/hook', false).hostname,
    '127.0.0.1',
  );
  assert.equal(isPrivateOrLocalAddress('10.1.2.3'), true);
  assert.equal(isPrivateOrLocalAddress('169.254.169.254'), true);
  assert.equal(isPrivateOrLocalAddress('192.0.0.1'), true);
  assert.equal(isPrivateOrLocalAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrLocalAddress('fc00::1'), true);
  assert.equal(isPrivateOrLocalAddress('fec0::1'), true);
  assert.equal(isPrivateOrLocalAddress('::127.0.0.1'), true);
  assert.equal(isPrivateOrLocalAddress('64:ff9b::a9fe:a9fe'), true);
  assert.equal(isPrivateOrLocalAddress('2001:4860:4860::8888'), false);
});

test('enqueue stores the exact body encrypted and puts only the delivery id in Redis', async () => {
  let createData: Record<string, unknown> | undefined;
  let queuedData: Record<string, unknown> | undefined;
  let queueOptions: Record<string, unknown> | undefined;
  let createCalls = 0;
  let queueCalls = 0;
  const prisma = {
    didiOrderWebhookForwardTarget: {
      findUnique: async () => ({
        id: 'target-1',
        enabled: true,
        revision: 1,
        urlEncrypted: encrypt('https://receiver.example/orders', KEY),
        hostname: 'receiver.example',
      }),
    },
    didiOrderWebhookForwardDelivery: {
      create: async (input: { data: Record<string, unknown> }) => {
        createCalls += 1;
        if (createCalls > 1) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate delivery', {
            code: 'P2002',
            clientVersion: '5.19.1',
          });
        }
        createData = input.data;
        return { id: 'delivery-1' };
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const queue = {
    add: async (_name: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
      queueCalls += 1;
      queuedData = data;
      queueOptions = options;
    },
  };
  const config = { getOrThrow: () => KEY };
  const subject = new DidiOrderForwardingService(
    prisma as never,
    queue as never,
    config as never,
  );
  const rawBody = Buffer.from('{ "type" : "orderNew", "exact" : 1 }\n', 'utf8');

  const deliveryId = await subject.persist({
    applicationId: 'application-1',
    requestId: 'request-1',
    orderId: '9007199254740993',
    eventType: 'orderNew',
    rawBody,
  });
  assert.equal(deliveryId, 'delivery-1');
  subject.publish(deliveryId!);
  await new Promise<void>(resolve => setImmediate(resolve));
  const duplicateId = await subject.persist({
    applicationId: 'application-1',
    requestId: 'request-2',
    orderId: '9007199254740993',
    eventType: 'orderNew',
    rawBody,
  });

  assert.equal(duplicateId, null);
  assert.equal(queueCalls, 1);
  assert.deepEqual(queuedData, { deliveryId: 'delivery-1' });
  assert.equal(Object.keys(queuedData ?? {}).length, 1);
  assert.equal(queueOptions?.attempts, 3);
  assert.deepEqual(queueOptions?.backoff, { type: 'exponential', delay: 5_000 });
  const encrypted = String(createData?.payloadEncrypted);
  assert.notEqual(encrypted, rawBody.toString('utf8'));
  assert.deepEqual(Buffer.from(decrypt(encrypted, KEY), 'base64'), rawBody);
  assert.equal(createData?.orderId, '9007199254740993');
  assert.equal(createData?.eventType, 'orderNew');
  assert.equal(createData?.targetRevision, 1);
  assert.equal(decrypt(String(createData?.urlEncrypted), KEY), 'https://receiver.example/orders');
  assert.equal(createData?.hostname, 'receiver.example');
});

test('a Redis enqueue failure retains encrypted data and the recovery pass re-queues it', async () => {
  const updateData: Array<Record<string, unknown>> = [];
  let addCalls = 0;
  const prisma = {
    didiOrderWebhookForwardTarget: {
      findUnique: async () => ({
        id: 'target-1',
        enabled: true,
        revision: 1,
        urlEncrypted: encrypt('https://receiver.example/orders', KEY),
        hostname: 'receiver.example',
      }),
    },
    didiOrderWebhookForwardDelivery: {
      create: async () => ({ id: 'delivery-recover' }),
      updateMany: async (input: { data: Record<string, unknown> }) => {
        updateData.push(input.data);
        return { count: 1 };
      },
      findMany: async () => [{ id: 'delivery-recover' }],
    },
  };
  const queue = {
    add: async () => {
      addCalls += 1;
      if (addCalls === 1) throw new Error('Redis unavailable');
    },
    getJob: async () => null,
  };
  const subject = new DidiOrderForwardingService(
    prisma as never,
    queue as never,
    { getOrThrow: () => KEY } as never,
  );

  const deliveryId = await subject.persist({
    applicationId: 'application-1',
    requestId: 'request-1',
    orderId: 'order-1',
    eventType: 'orderNew',
    rawBody: Buffer.from('{"type":"orderNew"}'),
  });
  assert.equal(deliveryId, 'delivery-recover');
  subject.publish(deliveryId!);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(addCalls, 1);
  assert.equal(updateData[0]?.errorMessage, 'Forwarding job could not be queued');
  assert.equal('payloadEncrypted' in updateData[0], false);
  assert.equal('status' in updateData[0], false);

  await (subject as unknown as {
    recoverPendingDeliveries(): Promise<void>;
  }).recoverPendingDeliveries();
  assert.equal(addCalls, 2);
});

test('publishing a durable delivery does not wait for a slow Redis operation', async () => {
  let markQueueStarted!: () => void;
  const queueStarted = new Promise<void>(resolve => { markQueueStarted = resolve; });
  const neverQueued = new Promise<void>(() => undefined);
  const prisma = {
    didiOrderWebhookForwardTarget: {
      findUnique: async () => ({
        id: 'target-1',
        enabled: true,
        revision: 1,
        urlEncrypted: encrypt('https://receiver.example/orders', KEY),
        hostname: 'receiver.example',
      }),
    },
    didiOrderWebhookForwardDelivery: {
      create: async () => ({ id: 'delivery-slow-redis' }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const queue = {
    add: async () => {
      markQueueStarted();
      await neverQueued;
    },
  };
  const subject = new DidiOrderForwardingService(
    prisma as never,
    queue as never,
    { getOrThrow: () => KEY } as never,
  );
  const deliveryId = await subject.persist({
    applicationId: 'application-1',
    requestId: 'request-1',
    orderId: 'order-1',
    eventType: 'orderNew',
    rawBody: Buffer.from('{"type":"orderNew"}'),
  });

  const publicationResult = subject.publish(deliveryId!);
  assert.equal(publicationResult, undefined);
  await queueStarted;
});

test('application webhook config returns forwarding state and retains its URL when disabled', async () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  let target: {
    id: string;
    applicationId: string;
    enabled: boolean;
    revision: number;
    urlEncrypted: string;
    hostname: string;
    updatedAt: Date;
    deliveries: unknown[];
  } | null = null;
  const application = {
    id: 'application-1',
    appName: 'Orders App',
    deletedAt: null,
    orderWebhookTokenEncrypted: null,
    orderWebhookTokenHash: null,
    orderWebhookCreatedAt: null,
    orderWebhookRotatedAt: null,
    orderWebhookDisabledAt: null,
  };
  const prisma = {
    application: { findUnique: async () => application },
    didiOrderWebhookEvent: { findFirst: async () => null },
    didiOrderWebhookForwardTarget: {
      findUnique: async () => target,
      create: async (input: {
        data: Omit<NonNullable<typeof target>, 'id' | 'revision' | 'updatedAt' | 'deliveries'>;
      }) => {
        target = {
          id: 'target-1',
          ...input.data,
          revision: 1,
          updatedAt: now,
          deliveries: [],
        };
        return target;
      },
      update: async (input: {
        data: Omit<Partial<NonNullable<typeof target>>, 'revision'> & {
          revision?: number | { increment: number };
        };
      }) => {
        const revision = typeof input.data.revision === 'object'
          ? target!.revision + input.data.revision.increment
          : input.data.revision ?? target!.revision;
        target = { ...target!, ...input.data, revision, updatedAt: now };
        return target;
      },
    },
  };
  const config = {
    getOrThrow: () => KEY,
    get: (name: string, fallback?: string) => name === 'NODE_ENV' ? 'test' : fallback,
  };
  const subject = new ApplicationsService(prisma as never, config as never);

  const enabled = await subject.updateOrderWebhookForwarding('application-1', {
    enabled: true,
    url: 'http://127.0.0.1:4567/orders',
  });
  assert.deepEqual(enabled.forwarding, {
    enabled: true,
    url: 'http://127.0.0.1:4567/orders',
    hostname: '127.0.0.1',
    updatedAt: now,
    lastDelivery: null,
  });

  const disabled = await subject.updateOrderWebhookForwarding('application-1', {
    enabled: false,
  });
  assert.equal(disabled.forwarding.enabled, false);
  assert.equal(disabled.forwarding.url, 'http://127.0.0.1:4567/orders');
  assert.equal(disabled.forwarding.hostname, '127.0.0.1');
  assert.equal((target as { revision: number } | null)?.revision, 2);
});

test('processor posts the exact body with delivery headers and purges it after success', async () => {
  const rawBody = Buffer.from('{\n  "type": "orderNew",\n  "order": 9007199254740993\n}\n', 'utf8');
  let receivedBody = Buffer.alloc(0);
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      receivedBody = Buffer.concat(chunks);
      receivedHeaders = request.headers;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    didiOrderWebhookForwardDelivery: {
      findUnique: async () => ({
        id: 'delivery-1',
        status: 'queued',
        eventType: 'orderNew',
        targetRevision: 1,
        urlEncrypted: encrypt(`http://127.0.0.1:${port}/orders?source=guaro`, KEY),
        hostname: '127.0.0.1',
        payloadEncrypted: encrypt(rawBody.toString('base64'), KEY),
        startedAt: null,
        target: {
          enabled: true,
          revision: 1,
        },
      }),
      update: async (input: { data: Record<string, unknown> }) => {
        updates.push(input.data);
        return input.data;
      },
    },
  };
  const config = {
    getOrThrow: () => KEY,
    get: () => 'test',
  };
  const subject = new DidiOrderForwardingProcessor(prisma as never, config as never);

  try {
    await subject.process({
      data: { deliveryId: 'delivery-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  assert.deepEqual(receivedBody, rawBody);
  assert.equal(receivedHeaders['content-type'], 'application/json');
  assert.equal(receivedHeaders['x-guaro-delivery-id'], 'delivery-1');
  assert.equal(receivedHeaders['x-guaro-event'], 'orderNew');
  assert.equal(updates[0]?.status, 'processing');
  assert.equal(updates[1]?.status, 'delivered');
  assert.equal(updates[1]?.payloadEncrypted, null);
  assert.equal(updates[1]?.httpStatus, 204);
});
