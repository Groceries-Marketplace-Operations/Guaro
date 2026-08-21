import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Country,
  KaType,
  StoreOnboardingNotificationFrequency,
  StoreOnboardingSource,
} from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { StoreOnboardingConfigService } from '../src/store-onboarding/store-onboarding-config.service';
import {
  notificationTemplateValidationErrors,
  STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
} from '../src/store-onboarding/store-onboarding-notification-contract';

const USER = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  roles: [],
  sectionId: null,
  adminModules: [],
  bpoPermissions: [],
};
const CREATE_TASK_TYPE = '20000000-0000-4000-8000-000000000001';
const BRAND_TASK_TYPE = '20000000-0000-4000-8000-000000000002';
const WEBHOOK_ID = '30000000-0000-4000-8000-000000000001';
const PROFILE_ID = '40000000-0000-4000-8000-000000000001';

test('missing Store Onboarding control is fail-closed while the operational code is ready', async () => {
  const prisma = {
    storeOnboardingControl: { findUnique: async () => null },
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  const status = await service.status();

  assert.equal(status.configured, false);
  assert.equal(status.operationalReady, true);
  assert.equal(status.activationAllowed, true);
  assert.equal(status.globalEnabled, false);
  assert.equal(status.notificationsEnabled, false);
  assert.equal(status.requestedGlobalEnabled, false);
});

test('activation readiness rejects a rollout whose latest published profile revision is scope-incompatible', async () => {
  let controlWrites = 0;
  const runtimeRollout = {
    id: 'rollout-runtime',
    country: Country.MX,
    kaType: KaType.KA,
    revision: 1,
    enabled: true,
    effectiveAt: new Date('2026-08-20T00:00:00.000Z'),
    activatedAt: new Date('2026-08-20T00:00:00.000Z'),
    sourceTaskTypes: [{ source: StoreOnboardingSource.create }],
    notificationProfile: { logicalKey: 'mx-ka-runtime' },
  };
  const tx = {
    $executeRaw: async () => 1,
    storeOnboardingControl: {
      findUnique: async () => null,
      upsert: async () => { controlWrites++; return null; },
    },
    storeOnboardingRolloutRevision: { findMany: async () => [runtimeRollout] },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({
        enabled: true,
        country: Country.CO,
        kaType: KaType.KA,
        sources: [StoreOnboardingSource.create],
      }),
    },
  };
  const prisma = {
    storeOnboardingControl: { findUnique: async () => null },
    storeOnboardingRolloutRevision: tx.storeOnboardingRolloutRevision,
    storeOnboardingNotificationProfile: tx.storeOnboardingNotificationProfile,
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  const status = await service.status();
  assert.equal(status.activationReadiness.ready, false);
  assert.equal(status.activationReadiness.readyScopeCount, 0);
  await assert.rejects(
    service.updateControl({
      globalEnabled: true,
      notificationsEnabled: false,
      activationConfirmed: true,
    }, USER),
    BadRequestException,
  );
  assert.equal(controlWrites, 0);
});

test('master activation requires explicit confirmation and rejects notifications without master', async () => {
  let writes = 0;
  const prisma = {
    $transaction: async () => { writes++; },
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  await assert.rejects(
    service.updateControl({ globalEnabled: true, notificationsEnabled: false }, USER),
    (error: unknown) => error instanceof ConflictException
      && (error.getResponse() as { operationalReady?: boolean }).operationalReady === true,
  );
  assert.equal(writes, 0);

  await assert.rejects(
    service.updateControl({ globalEnabled: false, notificationsEnabled: true, activationConfirmed: true }, USER),
    BadRequestException,
  );
  assert.equal(writes, 0);
});

test('master control appends a complete audit revision in the same transaction when flags change', async () => {
  const previous = {
    id: 'default',
    globalEnabled: false,
    notificationsEnabled: false,
    globalEnabledAt: null,
    notificationsEnabledAt: null,
    activationConfirmedAt: null,
    updatedById: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  };
  const row = {
    ...previous,
    globalEnabled: true,
    notificationsEnabled: true,
    globalEnabledAt: new Date('2026-08-21T00:00:00.000Z'),
    notificationsEnabledAt: new Date('2026-08-21T00:00:00.000Z'),
    activationConfirmedAt: new Date('2026-08-21T00:00:00.000Z'),
    updatedById: USER.id,
  };
  let transactionActive = false;
  let auditCreatedInsideTransaction = false;
  let revisionData: Record<string, unknown> | undefined;
  const tx = {
    $executeRaw: async () => 1,
    storeOnboardingControl: {
      findUnique: async () => previous,
      upsert: async () => row,
    },
    storeOnboardingControlRevision: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditCreatedInsideTransaction = transactionActive;
        revisionData = data;
        return { id: 'control-revision-1', ...data };
      },
    },
    storeOnboardingRolloutRevision: {
      findMany: async () => [{
        id: 'rollout-runtime',
        country: Country.MX,
        kaType: KaType.KA,
        enabled: true,
        sourceTaskTypes: [{ source: StoreOnboardingSource.create }],
        notificationProfile: { logicalKey: 'mx-ka-runtime' },
      }],
    },
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({
        enabled: true,
        country: Country.MX,
        kaType: KaType.KA,
        sources: [StoreOnboardingSource.create],
      }),
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => unknown) => {
      transactionActive = true;
      try {
        return await callback(tx);
      } finally {
        transactionActive = false;
      }
    },
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  const result = await service.updateControl({
    globalEnabled: true,
    notificationsEnabled: true,
    activationConfirmed: true,
    reason: '  Enable the Mexico KA pilot  ',
  }, USER);

  assert.equal(auditCreatedInsideTransaction, true);
  assert.deepEqual(revisionData, {
    controlId: 'default',
    beforeGlobalEnabled: false,
    afterGlobalEnabled: true,
    beforeNotificationsEnabled: false,
    afterNotificationsEnabled: true,
    activationConfirmed: true,
    actorId: USER.id,
    reason: 'Enable the Mexico KA pilot',
  });
  assert.equal(result.globalEnabled, true);
  assert.equal(result.notificationsEnabled, true);
});

test('master control no-op updates do not append an audit revision', async () => {
  const row = {
    id: 'default',
    globalEnabled: false,
    notificationsEnabled: false,
    globalEnabledAt: null,
    notificationsEnabledAt: null,
    activationConfirmedAt: null,
    updatedById: USER.id,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-21T00:00:00.000Z'),
  };
  let revisionCreates = 0;
  let suppressedOutbox = 0;
  let suppressedDeliveries = 0;
  const tx = {
    $executeRaw: async () => 1,
    storeOnboardingControl: {
      findUnique: async () => row,
      upsert: async () => row,
    },
    storeOnboardingControlRevision: {
      create: async () => { revisionCreates++; },
    },
    storeOnboardingOutboxEvent: {
      updateMany: async () => { suppressedOutbox++; return { count: 0 }; },
    },
    storeOnboardingNotificationDelivery: {
      updateMany: async () => { suppressedDeliveries++; return { count: 0 }; },
    },
  };
  const service = new StoreOnboardingConfigService({
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as never);

  await service.updateControl({
    globalEnabled: false,
    notificationsEnabled: false,
    reason: 'No effective change',
  }, USER);

  assert.equal(revisionCreates, 0);
  assert.equal(suppressedOutbox, 1);
  assert.equal(suppressedDeliveries, 1);
});

test('master control audit failure propagates and leaves the control transaction uncommitted', async () => {
  const auditFailure = new Error('audit insert failed');
  let committed = {
    id: 'default',
    globalEnabled: true,
    notificationsEnabled: true,
    globalEnabledAt: new Date('2026-08-20T00:00:00.000Z'),
    notificationsEnabledAt: new Date('2026-08-20T00:00:00.000Z'),
    activationConfirmedAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedById: USER.id,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  };
  let suppressionWrites = 0;
  const prisma = {
    $transaction: async (callback: (client: any) => unknown) => {
      let pending = { ...committed };
      const tx = {
        $executeRaw: async () => 1,
        storeOnboardingControl: {
          findUnique: async () => ({ ...pending }),
          upsert: async () => {
            pending = {
              ...pending,
              globalEnabled: false,
              notificationsEnabled: false,
            };
            return { ...pending };
          },
        },
        storeOnboardingControlRevision: {
          create: async () => { throw auditFailure; },
        },
        storeOnboardingOutboxEvent: {
          updateMany: async () => { suppressionWrites++; return { count: 0 }; },
        },
        storeOnboardingNotificationDelivery: {
          updateMany: async () => { suppressionWrites++; return { count: 0 }; },
        },
      };
      const result = await callback(tx);
      committed = pending;
      return result;
    },
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  await assert.rejects(service.updateControl({
    globalEnabled: false,
    notificationsEnabled: false,
    activationConfirmed: true,
    reason: 'Emergency disable',
  }, USER), error => error === auditFailure);

  assert.equal(committed.globalEnabled, true);
  assert.equal(committed.notificationsEnabled, true);
  assert.equal(suppressionWrites, 0);
});

test('rollout draft stores immutable mappings but remains unpublished and cannot shadow runtime', async () => {
  let created: Record<string, any> | undefined;
  const tx = {
    storeOnboardingRolloutRevision: {
      findFirst: async () => null,
      create: async (args: Record<string, any>) => {
        created = args;
        return {
          id: 'rollout-1',
          ...args.data,
          sourceTaskTypes: args.data.sourceTaskTypes.create,
        };
      },
    },
  };
  const prisma = {
    taskType: {
      findMany: async () => [{ id: CREATE_TASK_TYPE }, { id: BRAND_TASK_TYPE }],
    },
    storeOnboardingNotificationProfile: { findUnique: async () => null },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  await service.putRollout({
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    brandTaskTypeId: BRAND_TASK_TYPE,
    enabled: false,
    effectiveAt: '2026-08-22T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  }, USER);

  assert.ok(created);
  assert.equal(created.data.enabled, false);
  assert.equal(created.data.activatedAt, null);
  assert.equal(created.data.newRequestsOnly, true);
  assert.equal(created.data.brandTaskTypeId, BRAND_TASK_TYPE);
  assert.deepEqual(created.data.sourceTaskTypes.create, [{
    source: StoreOnboardingSource.create,
    taskTypeId: CREATE_TASK_TYPE,
  }]);
});

test('rollout activation needs confirmation, rejects backfill and unknown workflow engines', async () => {
  const service = new StoreOnboardingConfigService({} as never);
  const base = {
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    effectiveAt: '2026-08-22T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    timezone: 'America/Mexico_City',
  };

  await assert.rejects(
    service.putRollout({ ...base, enabled: true, newRequestsOnly: true }, USER),
    ConflictException,
  );
  await assert.rejects(
    service.putRollout({ ...base, enabled: false, newRequestsOnly: false }, USER),
    /only to Tasks created after activation/,
  );
  await assert.rejects(
    service.putRollout({ ...base, workflowVersion: 'future-v99', enabled: false, newRequestsOnly: true }, USER),
    /Unsupported workflowVersion/,
  );
});

test('v1 rejects manual sources, blank profile names and malformed legacy Task Type mappings', async () => {
  const service = new StoreOnboardingConfigService({} as never);
  const rolloutBase = {
    country: Country.MX,
    kaType: KaType.KA,
    enabled: false,
    effectiveAt: '2026-08-22T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  };

  await assert.rejects(service.putRollout({
    ...rolloutBase,
    sourceTaskTypes: [{ source: StoreOnboardingSource.manual, taskTypeId: CREATE_TASK_TYPE }],
  }, USER), /Unsupported Store Onboarding source in v1: manual/);
  await assert.rejects(service.putRollout({
    ...rolloutBase,
    sources: [StoreOnboardingSource.create],
    taskTypeIds: { [StoreOnboardingSource.create]: 'legacy-not-a-uuid' },
  }, USER), /Task Type mapping must be a UUID/);
  await assert.rejects(service.putNotificationProfile({
    logicalKey: 'mx-ka-manual',
    name: 'Manual source',
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.manual],
    webhookId: WEBHOOK_ID,
    enabled: false,
    frequency: StoreOnboardingNotificationFrequency.immediate,
    timezone: 'America/Mexico_City',
    criticalEvents: [],
    template: '{{ brand.name }}',
  }, USER), /Unsupported Store Onboarding source in v1: manual/);
  await assert.rejects(service.putNotificationProfile({
    logicalKey: 'mx-ka-blank-name',
    name: '   ',
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.create],
    webhookId: WEBHOOK_ID,
    enabled: false,
    frequency: StoreOnboardingNotificationFrequency.immediate,
    timezone: 'America/Mexico_City',
    criticalEvents: [],
    template: '{{ brand.name }}',
  }, USER), /Notification profile name is required/);
});

test('rollout publication rejects a self-prerequisite and requires a published notification profile', async () => {
  const base = {
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    effectiveAt: '2026-08-22T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    timezone: 'America/Mexico_City',
    newRequestsOnly: true,
  };
  const service = new StoreOnboardingConfigService({
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
  } as never);

  await assert.rejects(service.putRollout({
    ...base,
    enabled: false,
    brandTaskTypeId: CREATE_TASK_TYPE,
  }, USER), /cannot also be a Create\/Duplicate source/);
  await assert.rejects(service.putRollout({
    ...base,
    enabled: true,
    activationConfirmed: true,
  }, USER), /requires a published notification profile/);
});

test('published rollout and profile revisions acquire the exclusive control fence before creating runtime state', async () => {
  const rolloutOrder: string[] = [];
  const rolloutTx = {
    $executeRaw: async () => { rolloutOrder.push('lock'); return 1; },
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    storeOnboardingRolloutRevision: {
      findFirst: async () => { rolloutOrder.push('latest'); return null; },
      create: async (args: Record<string, any>) => {
        rolloutOrder.push('create');
        return {
          id: 'rollout-published-off',
          ...args.data,
          sourceTaskTypes: args.data.sourceTaskTypes.create,
          brandTaskType: null,
          notificationProfile: null,
        };
      },
    },
  };
  const rolloutService = new StoreOnboardingConfigService({
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    $transaction: async (callback: (client: typeof rolloutTx) => unknown) => callback(rolloutTx),
  } as never);
  await rolloutService.putRollout({
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    enabled: false,
    activationConfirmed: true,
    effectiveAt: '2026-08-23T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  }, USER);
  assert.deepEqual(rolloutOrder, ['lock', 'latest', 'create']);

  const profileOrder: string[] = [];
  const profileTx = {
    $executeRaw: async () => { profileOrder.push('lock'); return 1; },
    storeOnboardingNotificationProfile: {
      findFirst: async () => { profileOrder.push('latest'); return null; },
      create: async (args: Record<string, any>) => {
        profileOrder.push('create');
        return {
          id: 'profile-published-off',
          ...args.data,
          webhook: { id: WEBHOOK_ID, name: 'DChat Store notifications' },
          templates: [{ eventType: '*', content: args.data.templates.create.content }],
        };
      },
    },
  };
  const profileService = new StoreOnboardingConfigService({
    webhook: { findUnique: async () => ({ id: WEBHOOK_ID }) },
    $transaction: async (callback: (client: typeof profileTx) => unknown) => callback(profileTx),
  } as never);
  await profileService.putNotificationProfile({
    logicalKey: 'mx-ka-fenced',
    name: 'Mexico KA fenced profile',
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.create],
    webhookId: WEBHOOK_ID,
    enabled: false,
    activationConfirmed: true,
    frequency: StoreOnboardingNotificationFrequency.immediate,
    timezone: 'America/Mexico_City',
    criticalEvents: [],
    template: '{{ brand.name }}',
  }, USER);
  assert.deepEqual(profileOrder, ['lock', 'latest', 'create']);
});

test('a future published rollout can be cancelled at its exact boundary with a higher OFF revision', async () => {
  const futureBoundary = new Date(Date.now() + 3_600_000);
  const laterDraftBoundary = new Date(futureBoundary.getTime() + 3_600_000);
  let created: Record<string, any> | undefined;
  const tx = {
    $executeRaw: async () => 1,
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    storeOnboardingRolloutRevision: {
      findFirst: async (args: { where?: { activatedAt?: unknown } }) => (
        args.where?.activatedAt
          ? { revision: 4, enabled: true, effectiveAt: futureBoundary }
          : { revision: 5, effectiveAt: laterDraftBoundary }
      ),
      create: async (args: Record<string, any>) => {
        created = args;
        return {
          id: 'rollout-future-cancelled',
          ...args.data,
          sourceTaskTypes: args.data.sourceTaskTypes.create,
          brandTaskType: null,
          notificationProfile: null,
        };
      },
    },
  };
  const service = new StoreOnboardingConfigService({
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as never);

  const result = await service.putRollout({
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    enabled: false,
    activationConfirmed: true,
    effectiveAt: futureBoundary.toISOString(),
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  }, USER);

  assert.ok(created);
  assert.equal(created.data.revision, 6);
  assert.equal(created.data.enabled, false);
  assert.equal(created.data.effectiveAt.toISOString(), futureBoundary.toISOString());
  assert.ok(created.data.activatedAt instanceof Date);
  assert.equal(result.enabled, false);
});

test('an equal rollout boundary is rejected unless it cancels the latest published future ON revision', async () => {
  const boundary = new Date(Date.now() + 3_600_000);
  let creates = 0;
  const tx = {
    $executeRaw: async () => 1,
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    storeOnboardingRolloutRevision: {
      findFirst: async (args: { where?: { activatedAt?: unknown } }) => (
        args.where?.activatedAt
          ? { revision: 2, enabled: false, effectiveAt: boundary }
          : { revision: 2, effectiveAt: boundary }
      ),
      create: async () => { creates++; return {}; },
    },
  };
  const service = new StoreOnboardingConfigService({
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as never);

  await assert.rejects(service.putRollout({
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    enabled: false,
    activationConfirmed: true,
    effectiveAt: boundary.toISOString(),
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  }, USER), /effectiveAt must be later/);
  assert.equal(creates, 0);
});

test('rollout reads expose a future published activation even while runtime remains OFF', async () => {
  const futureBoundary = new Date(Date.now() + 3_600_000);
  const publishedAt = new Date();
  const future = {
    id: 'future-on',
    country: Country.MX,
    kaType: KaType.KA,
    revision: 2,
    enabled: true,
    effectiveAt: futureBoundary,
    activatedAt: publishedAt,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    brandTaskType: null,
    notificationProfile: null,
  };
  const service = new StoreOnboardingConfigService({
    storeOnboardingRolloutRevision: { findMany: async () => [future] },
    taskType: { findMany: async () => [] },
  } as never);

  const result = await service.listRollouts();

  assert.equal(result.data[0].runtimeEnabled, false);
  assert.equal(result.data[0].pendingActivation, true);
  assert.equal(result.data[0].pendingActivationRevisionId, future.id);
  assert.equal(result.data[0].pendingActivationEffectiveAt?.toISOString(), futureBoundary.toISOString());
});

test('rollout UI offers exact future cancellation even when the current runtime is OFF', () => {
  const source = readFileSync(join(
    __dirname,
    '../../frontend/src/pages/integrations/StoreOnboardingRolloutSettings.tsx',
  ), 'utf8');
  assert.match(source, /futureActivationPending/);
  assert.match(source, /'cancel-future'/);
  assert.match(source, /source\?\.pendingActivationEffectiveAt \?\?/);
  assert.match(source, /Cancelar activación futura/);
  assert.match(source, /cancelFutureActivation = !runtimeEnabled && futureActivationPending/);
  assert.match(source, /\(runtimeEnabled \|\| cancelFutureActivation\)/);
});

test('rollout publication revalidates the runtime notification profile after acquiring the exclusive fence', async () => {
  let rolloutCreates = 0;
  const publishedOn = {
    enabled: true,
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.create],
  };
  const publishedOff = { ...publishedOn, enabled: false };
  const tx = {
    $executeRaw: async () => 1,
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    storeOnboardingNotificationProfile: {
      findUnique: async () => ({ logicalKey: 'mx-ka-race' }),
      // This is the state visible after the profile-disable publication won
      // the same exclusive advisory lock.
      findFirst: async () => publishedOff,
    },
    storeOnboardingRolloutRevision: {
      findFirst: async () => null,
      create: async () => { rolloutCreates++; return {}; },
    },
  };
  const service = new StoreOnboardingConfigService({
    taskType: { findMany: async () => [{ id: CREATE_TASK_TYPE }] },
    storeOnboardingNotificationProfile: {
      findUnique: async () => ({ id: PROFILE_ID, logicalKey: 'mx-ka-race' }),
      // Preflight was valid before waiting for the publication fence.
      findFirst: async () => publishedOn,
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as never);

  await assert.rejects(service.putRollout({
    country: Country.MX,
    kaType: KaType.KA,
    sourceTaskTypes: [{ source: StoreOnboardingSource.create, taskTypeId: CREATE_TASK_TYPE }],
    enabled: true,
    activationConfirmed: true,
    notificationProfileId: PROFILE_ID,
    effectiveAt: '2026-08-24T00:00:00.000Z',
    workflowVersion: 'ka-v1',
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  }, USER), /enabled published notification profile/);
  assert.equal(rolloutCreates, 0);
});

test('notification templates reject unknown and malformed placeholders', () => {
  assert.deepEqual(notificationTemplateValidationErrors([{
    eventType: STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
    content: 'Brand {{ brand.name }} — {{ stores.total }} stores',
  }]), []);

  const errors = notificationTemplateValidationErrors([{
    eventType: STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
    content: 'Unsafe {{ account.password }} and malformed {{brand-name}}',
  }]);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /unknown placeholder: account\.password/);
  assert.match(errors.join('\n'), /invalid placeholder: brand-name/);
});

test('notification profiles reject an invalid IANA timezone before querying or writing', async () => {
  const service = new StoreOnboardingConfigService({} as never);
  await assert.rejects(service.putNotificationProfile({
    logicalKey: 'mx-ka-invalid-timezone',
    name: 'Invalid timezone',
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.create],
    webhookId: WEBHOOK_ID,
    enabled: false,
    frequency: StoreOnboardingNotificationFrequency.scheduled,
    scheduledTime: '09:00',
    timezone: 'Mars/Olympus_Mons',
    criticalEvents: [],
    template: '{{ brand.name }}',
  }, USER), BadRequestException);
});

test('notification profile save creates a versioned OFF draft and never needs a webhook URL', async () => {
  let created: Record<string, any> | undefined;
  let webhookSelect: Record<string, unknown> | undefined;
  const tx = {
    storeOnboardingNotificationProfile: {
      findFirst: async () => ({ revision: 2 }),
      create: async (args: Record<string, any>) => {
        created = args;
        return {
          id: 'profile-3',
          ...args.data,
          webhook: { id: WEBHOOK_ID, name: 'DChat Store notifications' },
          templates: [{ eventType: '*', content: args.data.templates.create.content }],
        };
      },
    },
  };
  const prisma = {
    webhook: {
      findUnique: async ({ select }: { select: Record<string, unknown> }) => {
        webhookSelect = select;
        return { id: WEBHOOK_ID };
      },
    },
    storeOnboardingNotificationProfile: { findUnique: async () => null },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  const profile = await service.putNotificationProfile({
    logicalKey: 'mx-ka-default',
    name: 'Mexico KA notifications',
    country: Country.MX,
    kaType: KaType.KA,
    sources: [StoreOnboardingSource.create],
    webhookId: WEBHOOK_ID,
    enabled: false,
    frequency: StoreOnboardingNotificationFrequency.digest,
    intervalMinutes: 60,
    timezone: 'America/Mexico_City',
    criticalEvents: ['audit.rejected', 'store.online_failed'],
    template: '{{ brand.name }}: {{ request.stage }}',
  }, USER);

  assert.deepEqual(webhookSelect, { id: true });
  assert.ok(created);
  assert.equal(created.data.revision, 3);
  assert.equal(created.data.enabled, false);
  assert.equal(created.data.activatedAt, null);
  assert.equal(profile.template, '{{ brand.name }}: {{ request.stage }}');
});

test('notification profile options expose webhook id/name but never its URL', async () => {
  let webhookQuery: Record<string, any> | undefined;
  const prisma = {
    storeOnboardingNotificationProfile: { findMany: async () => [] },
    webhook: {
      findMany: async (args: Record<string, any>) => {
        webhookQuery = args;
        return [{ id: WEBHOOK_ID, name: 'DChat Store notifications' }];
      },
    },
  };
  const service = new StoreOnboardingConfigService(prisma as never);

  const result = await service.listNotificationProfiles();

  assert.deepEqual(result.webhookOptions, [{ id: WEBHOOK_ID, name: 'DChat Store notifications' }]);
  assert.deepEqual(webhookQuery?.select, { id: true, name: true });
  assert.equal((webhookQuery?.select as Record<string, unknown> | undefined)?.url, undefined);
});

test('operational migration is additive DDL with no seed or backfill statements', () => {
  const sql = readFileSync(join(
    process.cwd(),
    '..',
    'prisma',
    'migrations',
    '20260821030000_store_onboarding_dormant_foundation',
    'migration.sql',
  ), 'utf8');

  assert.match(sql, /CREATE TABLE "store_onboarding_control"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_control_revision"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_rollout_source"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_notification_template"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_request"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_outbox_event"/);
  assert.match(sql, /CREATE TABLE "store_onboarding_notification_delivery"/);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
  const newTablesWithoutPrefix = new Set(['brand_provisioning', 'task_dependency']);
  assert.deepEqual(
    [...sql.matchAll(/ALTER TABLE "([^"]+)"/g)]
      .map(match => match[1])
      .filter(name => !name.startsWith('store_onboarding_') && !newTablesWithoutPrefix.has(name)),
    [],
  );
});
