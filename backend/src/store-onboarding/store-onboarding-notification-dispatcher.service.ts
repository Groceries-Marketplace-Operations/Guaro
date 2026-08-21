import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  Prisma,
  StoreOnboardingDeliveryStatus,
  StoreOnboardingNotificationFrequency,
  StoreOnboardingOutboxStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT } from './store-onboarding-notification-contract';

const CONTROL_ID = 'default';
const CONTROL_LOCK_KEY = 'store-onboarding-control';
const OUTBOX_BATCH_SIZE = 50;
const DELIVERY_GROUP_MAX_EVENTS = 50;
const DELIVERY_GROUP_MAX_CHARACTERS = 18_000;
const DELIVERY_TRUNCATION_SUFFIX = '\n\n… Mensaje truncado; consulte Guaro para ver el detalle completo.';
const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_LEASE_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000, 172_800_000, 604_800_000];
const PLACEHOLDER_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

type JsonObject = Record<string, unknown>;

type NotificationContext = {
  event: { type: string; occurredAt: string; actorName: string; note: string };
  request: { id: string; status: string; stage: string; url: string };
  task: { id: string; name: string; url: string };
  brand: { id: string; name: string; country: string; kaType: string };
  stores: { total: number | string; completed: number | string; failed: number | string };
  store: { shopId: string; appShopId: string; status: string };
  audit: { status: string };
  rtbo: { status: string };
  rollout: { country: string; kaType: string; workflowVersion: string };
};

type DeliveryTiming = { dueAt: Date; groupSuffix: string };

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function textValue(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (Array.isArray(value)) return value.map(item => textValue(item, '')).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function canonicalStoreOnboardingEventType(eventType: string, payload: unknown) {
  const raw = eventType.replace(/^store_onboarding\./, '');
  const data = objectValue(payload);
  if (raw === 'stage.changed') {
    const target = textValue(data.toStage, '');
    const specialized: Record<string, string> = {
      configuring: 'configuration.started',
      configuration_validated: 'configuration.completed',
      awaiting_audit: 'audit.submitted',
      audit_needs_information: 'audit.needs_information',
      audit_rejected: 'audit.rejected',
      audit_approved: 'audit.approved',
      rtbo: 'rtbo.completed',
      going_online: 'go_live.started',
      online: 'store.online',
      online_failed: 'store.online_failed',
      blocked: 'request.blocked',
    };
    return specialized[target] ?? 'process.changed';
  }
  const aliases: Record<string, string> = {
    enrolled: 'request.enrolled',
    'request.created': 'stores.created',
    'shop_ids.confirmed': 'stores.created',
    'creation.failed': 'request.blocked',
    'configuration_brief.published': 'configuration.brief_published',
    online: 'store.online',
    online_failed: 'store.online_failed',
  };
  return aliases[raw] ?? raw;
}

export function renderStoreOnboardingTemplate(template: string, context: NotificationContext) {
  const flattened = new Map<string, unknown>();
  for (const [namespace, values] of Object.entries(context)) {
    for (const [key, value] of Object.entries(values)) flattened.set(`${namespace}.${key}`, value);
  }
  return template.replace(PLACEHOLDER_PATTERN, (_match, variable: string) => (
    textValue(flattened.get(variable.trim()))
  ));
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(value);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function nextStoreOnboardingScheduledAt(after: Date, scheduledTime: string, timezone: string) {
  const [targetHour, targetMinute] = scheduledTime.split(':');
  let cursor = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let minute = 0; minute < 60 * 49; minute++) {
    const parts = zonedParts(cursor, timezone);
    if (parts.hour === targetHour && parts.minute === targetMinute) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error(`Could not resolve scheduled notification time in timezone ${timezone}`);
}

export function storeOnboardingDeliveryTiming(input: {
  frequency: StoreOnboardingNotificationFrequency;
  intervalMinutes: number | null;
  scheduledTime: string | null;
  timezone: string;
  critical: boolean;
  occurredAt: Date;
}): DeliveryTiming {
  if (input.critical || input.frequency === StoreOnboardingNotificationFrequency.immediate) {
    return { dueAt: input.occurredAt, groupSuffix: `immediate:${input.occurredAt.toISOString()}` };
  }
  if (input.frequency === StoreOnboardingNotificationFrequency.digest) {
    const intervalMs = Math.max(1, input.intervalMinutes ?? 1) * 60_000;
    const windowStart = Math.floor(input.occurredAt.getTime() / intervalMs) * intervalMs;
    return {
      dueAt: new Date(windowStart + intervalMs),
      groupSuffix: `digest:${new Date(windowStart).toISOString()}`,
    };
  }
  if (!input.scheduledTime) throw new Error('Scheduled notification profile is missing scheduledTime');
  const dueAt = nextStoreOnboardingScheduledAt(input.occurredAt, input.scheduledTime, input.timezone);
  const parts = zonedParts(dueAt, input.timezone);
  return { dueAt, groupSuffix: `scheduled:${parts.year}-${parts.month}-${parts.day}` };
}

export function storeOnboardingRetryDecision(status: number | null, attemptCount: number) {
  const retryable = status === null || status === 408 || status === 425 || status === 429 || status >= 500;
  const retry = retryable && attemptCount < MAX_DELIVERY_ATTEMPTS;
  return {
    retry,
    delayMs: retry ? RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)] : null,
  };
}

export function parseStoreOnboardingRetryAfter(value: string | null, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function freezeStoreOnboardingDeliveryGroup(groupKey: string, deliveryIds: string[]) {
  if (groupKey.includes('::bundle:')) return groupKey;
  const bundleId = createHash('sha256').update([...deliveryIds].sort().join(':')).digest('hex');
  return `${groupKey}::bundle:${bundleId}`;
}

function composeStoreOnboardingDeliveryText(renderedBodies: string[]) {
  const rendered = renderedBodies.filter(Boolean);
  return rendered.length === 1
    ? rendered[0]
    : `Resumen de ${rendered.length} cambios de Store Onboarding\n\n${rendered.join('\n\n—\n\n')}`;
}

export function canAppendStoreOnboardingDeliveryBody(
  currentBodies: string[],
  nextBody: string,
  maxCharacters = DELIVERY_GROUP_MAX_CHARACTERS,
) {
  return currentBodies.length === 0
    || composeStoreOnboardingDeliveryText([...currentBodies, nextBody]).length <= maxCharacters;
}

export function limitStoreOnboardingDeliveryText(
  renderedBodies: string[],
  maxCharacters = DELIVERY_GROUP_MAX_CHARACTERS,
) {
  const text = composeStoreOnboardingDeliveryText(renderedBodies);
  const limit = Math.max(0, Math.floor(maxCharacters));
  if (text.length <= limit) return text;
  if (limit <= DELIVERY_TRUNCATION_SUFFIX.length) {
    return DELIVERY_TRUNCATION_SUFFIX.slice(0, limit);
  }
  return `${text.slice(0, limit - DELIVERY_TRUNCATION_SUFFIX.length).trimEnd()}${DELIVERY_TRUNCATION_SUFFIX}`;
}

@Injectable()
export class StoreOnboardingNotificationDispatcherService {
  private readonly logger = new Logger(StoreOnboardingNotificationDispatcherService.name);
  private running = false;
  private lastControlWarningAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/15 * * * * *')
  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      if (!await this.notificationsEnabled()) return;
      await this.releaseExpiredLeases();
      for (let batch = 0; batch < 5; batch++) {
        if (!await this.expandOutboxBatch()) break;
      }
      for (let batch = 0; batch < 5; batch++) {
        if (!await this.deliverDueBatch()) break;
      }
    } catch (error) {
      this.logger.error(`Store Onboarding notification poll failed: ${this.safeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  async expandOutboxBatch() {
    if (!await this.notificationsEnabled()) return 0;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${CONTROL_LOCK_KEY}))`;
      const control = await tx.storeOnboardingControl.findUnique({
        where: { id: CONTROL_ID },
        select: { globalEnabled: true, notificationsEnabled: true },
      });
      if (!control?.globalEnabled || !control.notificationsEnabled) return 0;
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM store_onboarding_outbox_event
        WHERE status = 'pending'::"StoreOnboardingOutboxStatus"
          AND available_at <= NOW()
        ORDER BY occurred_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${OUTBOX_BATCH_SIZE}
      `;
      if (!claimed.length) return 0;
      const ids = claimed.map(row => row.id);
      await tx.storeOnboardingOutboxEvent.updateMany({
        where: { id: { in: ids }, status: StoreOnboardingOutboxStatus.pending },
        data: { status: StoreOnboardingOutboxStatus.processing, processingStartedAt: new Date(), attempts: { increment: 1 } },
      });
      for (const id of ids) {
        try {
          await this.expandOneEvent(tx, id);
        } catch (error) {
          await tx.storeOnboardingOutboxEvent.update({
            where: { id },
            data: {
              status: StoreOnboardingOutboxStatus.failed,
              processingStartedAt: null,
              lastError: this.safeError(error),
            },
          });
        }
      }
      return ids.length;
    });
  }

  async deliverDueBatch() {
    if (!await this.notificationsEnabled()) return 0;
    const claimed = await this.prisma.$transaction(async tx => {
      const groups = await tx.$queryRaw<Array<{ groupKey: string }>>`
        SELECT group_key AS "groupKey"
        FROM store_onboarding_notification_delivery
        WHERE status IN ('pending'::"StoreOnboardingDeliveryStatus", 'retry_wait'::"StoreOnboardingDeliveryStatus")
          AND next_attempt_at <= NOW()
        GROUP BY group_key
        ORDER BY MIN(next_attempt_at) ASC, MIN(id::text) ASC
        LIMIT 1
      `;
      if (!groups.length) return [];
      const advisory = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${'store-onboarding-delivery:' + groups[0].groupKey})) AS locked
      `;
      if (!advisory[0]?.locked) return [];
      const rows = await tx.$queryRaw<Array<{ id: string; renderedBody: string | null }>>`
        SELECT id, rendered_body AS "renderedBody"
        FROM store_onboarding_notification_delivery
        WHERE group_key = ${groups[0].groupKey}
          AND status IN ('pending'::"StoreOnboardingDeliveryStatus", 'retry_wait'::"StoreOnboardingDeliveryStatus")
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC, id ASC
        FOR UPDATE
        LIMIT ${DELIVERY_GROUP_MAX_EVENTS}
      `;
      const selected: typeof rows = [];
      for (const row of rows) {
        const selectedBodies = selected.map(item => item.renderedBody ?? '');
        if (!canAppendStoreOnboardingDeliveryBody(selectedBodies, row.renderedBody ?? '')) break;
        selected.push(row);
      }
      const ids = selected.map(row => row.id);
      if (!ids.length) return [];
      const frozenGroupKey = freezeStoreOnboardingDeliveryGroup(groups[0].groupKey, ids);
      const now = new Date();
      await tx.storeOnboardingNotificationDelivery.updateMany({
        where: { id: { in: ids } },
        data: {
          groupKey: frozenGroupKey,
          status: StoreOnboardingDeliveryStatus.processing,
          processingStartedAt: now,
          lastAttemptAt: now,
          attemptCount: { increment: 1 },
        },
      });
      return tx.storeOnboardingNotificationDelivery.findMany({
        where: { id: { in: ids } },
        include: {
          outboxEvent: { select: { id: true, eventKey: true } },
          profileRevision: {
            include: { webhook: { select: { url: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
    if (!claimed.length) return 0;
    const claimedIds = claimed.map(row => row.id);
    return this.prisma.$transaction(async tx => {
      // Shared fencing stays held through the HTTP attempt. A master disable
      // takes the exclusive form of this lock, so no delivery can start after
      // OFF commits; calls already in flight finish before OFF becomes active.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${CONTROL_LOCK_KEY}))`;
      const control = await tx.storeOnboardingControl.findUnique({
        where: { id: CONTROL_ID },
        select: { globalEnabled: true, notificationsEnabled: true },
      });
      if (!control?.globalEnabled || !control.notificationsEnabled) {
        await tx.storeOnboardingNotificationDelivery.updateMany({
          where: { id: { in: claimedIds }, status: StoreOnboardingDeliveryStatus.processing },
          data: {
            status: StoreOnboardingDeliveryStatus.suppressed,
            processingStartedAt: null,
            lastError: 'Notifications disabled before delivery',
          },
        });
        return claimedIds.length;
      }
      const active = await tx.storeOnboardingNotificationDelivery.findMany({
        where: { id: { in: claimedIds }, status: StoreOnboardingDeliveryStatus.processing },
        include: {
          outboxEvent: { select: { id: true, eventKey: true } },
          profileRevision: { include: { webhook: { select: { url: true } } } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!active.length) return claimedIds.length;
      const latestRuntime = await tx.storeOnboardingNotificationProfile.findFirst({
        where: {
          logicalKey: active[0].profileRevision.logicalKey,
          activatedAt: { not: null, lte: new Date() },
        },
        select: { enabled: true },
        orderBy: [{ activatedAt: 'desc' }, { revision: 'desc' }],
      });
      if (!latestRuntime?.enabled) {
        await tx.storeOnboardingNotificationDelivery.updateMany({
          where: { id: { in: active.map(row => row.id) }, status: StoreOnboardingDeliveryStatus.processing },
          data: {
            status: StoreOnboardingDeliveryStatus.suppressed,
            processingStartedAt: null,
            lastError: 'Notification profile disabled before delivery',
          },
        });
        return active.length;
      }

      const text = limitStoreOnboardingDeliveryText(active.map(row => row.renderedBody ?? ''));
      const eventIds = active.map(row => row.outboxEvent.eventKey);
      const idempotencyKey = createHash('sha256').update(active[0].groupKey).digest('hex');
      let responseStatus: number | null = null;
      let retryAfterMs: number | null = null;
      let failure: string | null = null;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          const response = await fetch(active[0].profileRevision.webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
              'X-Guaro-Event-Id': eventIds.length === 1 ? eventIds[0] : idempotencyKey,
              'X-Guaro-Event-Count': String(eventIds.length),
            },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          });
          responseStatus = response.status;
          retryAfterMs = parseStoreOnboardingRetryAfter(response.headers.get('Retry-After'));
          await response.body?.cancel().catch(() => undefined);
          if (!response.ok) failure = `Webhook returned HTTP ${response.status}`;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        failure = this.safeError(error);
      }

      const attemptCount = Math.max(...active.map(row => row.attemptCount));
      if (!failure) {
        await tx.storeOnboardingNotificationDelivery.updateMany({
          where: { id: { in: active.map(row => row.id) }, status: StoreOnboardingDeliveryStatus.processing },
          data: {
            status: StoreOnboardingDeliveryStatus.delivered,
            deliveredAt: new Date(),
            processingStartedAt: null,
            responseStatus,
            responseBody: null,
            lastError: null,
          },
        });
        return active.length;
      }

      const decision = storeOnboardingRetryDecision(responseStatus, attemptCount);
      const delayMs = decision.retry ? Math.max(decision.delayMs!, retryAfterMs ?? 0) : null;
      await tx.storeOnboardingNotificationDelivery.updateMany({
        where: { id: { in: active.map(row => row.id) }, status: StoreOnboardingDeliveryStatus.processing },
        data: decision.retry
          ? {
            status: StoreOnboardingDeliveryStatus.retry_wait,
            nextAttemptAt: new Date(Date.now() + delayMs!),
            processingStartedAt: null,
            responseStatus,
            responseBody: null,
            lastError: failure,
          }
          : {
            status: StoreOnboardingDeliveryStatus.failed,
            processingStartedAt: null,
            responseStatus,
            responseBody: null,
            lastError: failure,
          },
      });
      return active.length;
    }, { timeout: 15_000 });
  }

  private async expandOneEvent(tx: Prisma.TransactionClient, id: string) {
    const event = await tx.storeOnboardingOutboxEvent.findUnique({ where: { id } });
    if (!event || event.status !== StoreOnboardingOutboxStatus.processing) return;
    const requestWhere = event.requestId
      ? { id: event.requestId }
      : event.taskId
        ? { taskId: event.taskId }
        : null;
    const request = requestWhere ? await tx.storeOnboardingRequest.findUnique({
      where: requestWhere,
      select: {
        id: true,
        status: true,
        currentStage: true,
        source: true,
        totalUnits: true,
        completedUnits: true,
        failedUnits: true,
        countrySnapshot: true,
        kaTypeSnapshot: true,
        workflowVersion: true,
        brand: { select: { id: true, brandName: true } },
        task: { select: { id: true, taskType: { select: { name: true } } } },
        rolloutRevision: {
          select: { notificationProfile: { select: { logicalKey: true } } },
        },
      },
    }) : null;
    const enrollment = !request && event.taskId ? await tx.storeOnboardingTaskEnrollment.findUnique({
      where: { taskId: event.taskId },
      select: {
        source: true,
        countrySnapshot: true,
        kaTypeSnapshot: true,
        workflowVersion: true,
        rolloutRevision: { select: { notificationProfile: { select: { logicalKey: true } } } },
        task: {
          select: {
            id: true,
            taskType: { select: { name: true } },
            brand: { select: { id: true, brandName: true } },
          },
        },
      },
    }) : null;
    const logicalKey = request?.rolloutRevision.notificationProfile?.logicalKey
      ?? enrollment?.rolloutRevision?.notificationProfile?.logicalKey;
    if (!logicalKey) {
      await tx.storeOnboardingOutboxEvent.update({
        where: { id },
        data: { status: StoreOnboardingOutboxStatus.suppressed, processingStartedAt: null, lastError: 'No notification profile is linked to the rollout' },
      });
      return;
    }
    const profile = await tx.storeOnboardingNotificationProfile.findFirst({
      where: { logicalKey, activatedAt: { not: null, lte: event.occurredAt } },
      include: { templates: true },
      orderBy: [{ activatedAt: 'desc' }, { revision: 'desc' }],
    });
    const source = request?.source ?? enrollment?.source;
    const country = request?.countrySnapshot ?? enrollment?.countrySnapshot;
    const kaType = request?.kaTypeSnapshot ?? enrollment?.kaTypeSnapshot;
    if (
      !profile?.enabled
      || !source
      || (profile.country && profile.country !== country)
      || (profile.kaType && profile.kaType !== kaType)
      || !profile.sources.includes(source)
    ) {
      await tx.storeOnboardingOutboxEvent.update({
        where: { id },
        data: { status: StoreOnboardingOutboxStatus.suppressed, processingStartedAt: null, lastError: 'No enabled notification profile matches this event snapshot' },
      });
      return;
    }

    const payload = objectValue(event.payload);
    const eventType = canonicalStoreOnboardingEventType(event.eventType, payload);
    const template = profile.templates.find(row => row.eventType === eventType)
      ?? profile.templates.find(row => row.eventType === STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT);
    if (!template) {
      await tx.storeOnboardingOutboxEvent.update({
        where: { id },
        data: { status: StoreOnboardingOutboxStatus.failed, processingStartedAt: null, lastError: `No template for event ${eventType}` },
      });
      return;
    }
    const unit = event.unitId ? await tx.storeOnboardingUnit.findUnique({
      where: { id: event.unitId },
      select: { externalShopId: true, appShopId: true, stage: true, auditStatus: true, rtboAt: true },
    }) : null;
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    const actor = actorId ? await tx.account.findUnique({ where: { id: actorId }, select: { name: true } }) : null;
    const taskId = request?.task.id ?? enrollment?.task.id ?? event.taskId ?? '';
    const brandId = request?.brand.id ?? enrollment?.task.brand?.id ?? '';
    const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    const context: NotificationContext = {
      event: {
        type: eventType,
        occurredAt: event.occurredAt.toISOString(),
        actorName: actor?.name ?? textValue(payload.actorName),
        note: textValue(payload.note),
      },
      request: {
        id: request?.id ?? event.requestId ?? '',
        status: request?.status ?? textValue(payload.requestStatus),
        stage: request?.currentStage ?? textValue(payload.stage ?? payload.toStage),
        url: request?.id ? `${frontendUrl}/integrations/store-onboarding/${request.id}` : '',
      },
      task: {
        id: taskId,
        name: request?.task.taskType.name ?? enrollment?.task.taskType.name ?? '',
        url: taskId ? `${frontendUrl}/tasks/${taskId}` : '',
      },
      brand: {
        id: brandId,
        name: request?.brand.brandName ?? enrollment?.task.brand?.brandName ?? '',
        country: textValue(country),
        kaType: textValue(kaType),
      },
      stores: {
        total: request?.totalUnits ?? textValue(payload.totalUnits, '0'),
        completed: request?.completedUnits ?? textValue(payload.completedUnits, '0'),
        failed: request?.failedUnits ?? textValue(payload.failedUnits, '0'),
      },
      store: {
        shopId: unit?.externalShopId ?? textValue(payload.externalShopId ?? payload.shopId),
        appShopId: unit?.appShopId ?? textValue(payload.appShopId),
        status: unit?.stage ?? textValue(payload.storeStatus ?? payload.toStage),
      },
      audit: { status: unit?.auditStatus ?? textValue(payload.auditDecision) },
      rtbo: { status: unit?.rtboAt ? 'completed' : textValue(payload.rtboStatus, 'pending') },
      rollout: {
        country: textValue(country),
        kaType: textValue(kaType),
        workflowVersion: request?.workflowVersion ?? enrollment?.workflowVersion ?? '',
      },
    };
    const renderedBody = renderStoreOnboardingTemplate(template.content, context).trim();
    const timing = storeOnboardingDeliveryTiming({
      frequency: profile.frequency,
      intervalMinutes: profile.intervalMinutes,
      scheduledTime: profile.scheduledTime,
      timezone: profile.timezone,
      critical: profile.criticalEvents.includes(eventType),
      occurredAt: event.occurredAt,
    });
    await tx.storeOnboardingNotificationDelivery.upsert({
      where: { outboxEventId_profileRevisionId: { outboxEventId: event.id, profileRevisionId: profile.id } },
      create: {
        outboxEventId: event.id,
        profileRevisionId: profile.id,
        renderedBody,
        groupKey: `${profile.id}:${request?.id ?? taskId}:${timing.groupSuffix}`,
        nextAttemptAt: timing.dueAt,
      },
      update: {},
    });
    await tx.storeOnboardingOutboxEvent.update({
      where: { id },
      data: { status: StoreOnboardingOutboxStatus.dispatched, processingStartedAt: null, lastError: null },
    });
  }

  private async notificationsEnabled() {
    try {
      const control = await this.prisma.storeOnboardingControl.findUnique({
        where: { id: CONTROL_ID },
        select: { globalEnabled: true, notificationsEnabled: true },
      });
      return control?.globalEnabled === true && control.notificationsEnabled === true;
    } catch (error) {
      const now = Date.now();
      if (now - this.lastControlWarningAt >= 5 * 60_000) {
        this.lastControlWarningAt = now;
        this.logger.warn(`Store Onboarding notifications remain OFF because control could not be read: ${this.safeError(error)}`);
      }
      return false;
    }
  }

  private async releaseExpiredLeases() {
    const before = new Date(Date.now() - DELIVERY_LEASE_MS);
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${CONTROL_LOCK_KEY}))`;
      const control = await tx.storeOnboardingControl.findUnique({
        where: { id: CONTROL_ID },
        select: { globalEnabled: true, notificationsEnabled: true },
      });
      if (!control?.globalEnabled || !control.notificationsEnabled) return;
      await Promise.all([
        tx.storeOnboardingOutboxEvent.updateMany({
        where: { status: StoreOnboardingOutboxStatus.processing, processingStartedAt: { lt: before } },
        data: { status: StoreOnboardingOutboxStatus.pending, processingStartedAt: null, availableAt: new Date(), lastError: 'Recovered expired processing lease' },
      }),
        tx.storeOnboardingNotificationDelivery.updateMany({
        where: { status: StoreOnboardingDeliveryStatus.processing, processingStartedAt: { lt: before } },
        data: { status: StoreOnboardingDeliveryStatus.retry_wait, processingStartedAt: null, nextAttemptAt: new Date(), lastError: 'Recovered expired delivery lease' },
      }),
      ]);
    });
  }

  private suppressDeliveries(ids: string[], reason: string) {
    return this.prisma.storeOnboardingNotificationDelivery.updateMany({
      where: { id: { in: ids }, status: StoreOnboardingDeliveryStatus.processing },
      data: { status: StoreOnboardingDeliveryStatus.suppressed, processingStartedAt: null, lastError: reason },
    });
  }

  private safeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/https?:\/\/\S+/gi, '[redacted-url]').slice(0, 2_000);
  }
}
