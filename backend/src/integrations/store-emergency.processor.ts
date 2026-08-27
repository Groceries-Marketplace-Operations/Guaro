import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';
import {
  emergencyEventData,
  sanitizeEmergencyMessage,
  StoreEmergencyJobData,
} from './store-emergency-events';
import { StoreOpeningGuardService } from './store-opening-guard.service';

type EmergencyAction = 'offline' | 'restore';

interface StoreEmergencyTargetLease {
  emergencyId: string;
  targetId: string;
  action: EmergencyAction;
  updatedAt: Date;
}

interface StoreEmergencyReconcileLease {
  emergencyId: string;
  brandId: string;
  targetId: string;
  updatedAt: Date;
}

interface StoreEmergencyReconcileTarget {
  id: string;
  offlineStatus: string;
  restoreStatus: string;
  offlineError: string | null;
  updatedAt: Date;
  shop: { id: string; appShopId: string };
  events: Array<{ occurredAt: Date }>;
}

interface StoreStatusWriteResult {
  bizStatus: 1 | 2;
  autoSwitch: boolean | null;
  subBizStatus: number | null;
}

type StoreEmergencyReconcileResult = 'already_offline' | 'reapplied' | 'failed' | 'skipped';

const AUTH_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 8_000;
const RECONCILE_AUTH_TIMEOUT_MS = 10_000;
const RECONCILE_READ_TIMEOUT_MS = 8_000;
const RECONCILE_BATCH_SIZE = 1;
const RECONCILE_DETAIL_COOLDOWN_MS = 65_000;
const RECONCILE_HEALTHY_SAMPLE_MINUTES = 10;
const RECONCILE_VERIFICATION_PENDING = 'OFF request pending remote verification';
const RECONCILE_DETAIL_SLOT_EVENT = 'reconcile_detail_read_reserved';

function isDidiDetailRateLimit(error: unknown): boolean {
  return error instanceof Error && /\berrno\s*=\s*10005\b/i.test(error.message);
}

class StoreEmergencyLeaseLostError extends Error {
  constructor() {
    super('Store emergency target lease was lost before the provider write completed');
    this.name = 'StoreEmergencyLeaseLostError';
  }
}

@Injectable()
@Processor('store-emergency', { concurrency: 3 })
export class StoreEmergencyProcessor extends WorkerHost {
  private readonly logger = new Logger(StoreEmergencyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly openingGuard: StoreOpeningGuardService,
  ) { super(); }

  async process(job: Job<StoreEmergencyJobData>) {
    const { emergencyId, action } = job.data;
    if (action === 'reconcile') {
      await this.reconcile(job);
      return;
    }
    const actorId = job.data.actorId ?? null;
    const triggerSource = job.data.source ?? 'system';
    const phase = action === 'offline' ? 'shutdown' : 'restore';
    const actionAttempt = await this.prisma.storeEmergencyEvent.count({
      where: {
        emergencyId,
        type: action === 'offline' ? 'shutdown_started' : 'restore_started',
      },
    }) + 1;
    const startedAt = new Date();

    const snapshot = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      select: { status: true, startedAt: true, restoreStartedAt: true, finishedAt: true },
    });
    if (!snapshot) return;

    if (action === 'offline') {
      const claimed = await this.prisma.storeEmergency.updateMany({
        where: { id: emergencyId, status: 'pending', finishedAt: null },
        data: {
          status: 'running',
          errorMessage: null,
          ...(!snapshot.startedAt ? { startedAt } : {}),
        },
      });
      if (claimed.count === 0) {
        await this.recordSkippedJob(emergencyId, action, snapshot.status, job);
        return;
      }
    } else {
      if (snapshot.status !== 'restoring' || snapshot.finishedAt) {
        await this.recordSkippedJob(emergencyId, action, snapshot.status, job);
        return;
      }
      if (!snapshot.restoreStartedAt) {
        await this.prisma.storeEmergency.updateMany({
          where: { id: emergencyId, status: 'restoring', restoreStartedAt: null, finishedAt: null },
          data: { restoreStartedAt: startedAt },
        });
      }
    }

    await this.prisma.storeEmergencyEvent.create({
      data: emergencyEventData({
        emergencyId,
        type: action === 'offline' ? 'shutdown_started' : 'restore_started',
        phase,
        outcome: 'running',
        source: 'worker',
        actorId,
        attempt: actionAttempt,
        message: action === 'offline' ? 'Emergency shutdown processing started' : 'Store reopening processing started',
        metadata: {
          triggerSource,
          retry: job.data.retry === true,
          jobId: String(job.id ?? ''),
          jobAttempt: job.attemptsMade + 1,
        },
        occurredAt: startedAt,
      }),
    });
    await this.heartbeat(emergencyId, action);

    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      include: {
        brand: { include: { application: { select: { appId: true, appSecret: true } } } },
        targets: {
          select: {
            id: true,
            offlineStatus: true,
            restoreStatus: true,
            shop: { select: { id: true, appShopId: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!emergency) return;
    const application = emergency.brand.application;
    if (!application) {
      await this.failEmergency(emergency.id, action, 'Brand has no linked application credentials', job, actionAttempt);
      return;
    }

    let appSecret: string;
    try {
      const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
      appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
    } catch {
      await this.failEmergency(emergency.id, action, 'Application credential could not be decrypted', job, actionAttempt);
      return;
    }

    const targets = emergency.targets.filter(target => action === 'offline'
      ? target.offlineStatus === 'pending'
      : target.restoreStatus === 'required'
        || (target.offlineStatus === 'done' && target.restoreStatus === 'pending'));
    let cursor = 0;
    const workers = Math.min(3, Math.max(1, targets.length));
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) return;
        const target = targets[index];
        try {
          await this.processTarget(
            emergency.id,
            target.id,
            target.shop.id,
            target.shop.appShopId,
            application.appId,
            appSecret,
            action,
            target.restoreStatus,
            actorId,
            triggerSource,
          );
        } finally {
          await this.heartbeat(emergency.id, action);
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => worker()));
    await this.heartbeat(emergency.id, action);
    await this.finalize(emergency.id, action, job, actionAttempt);
  }

  private async reconcile(job: Job<StoreEmergencyJobData>) {
    const prepared = await this.prepareReconciliation(job.data.emergencyId);
    if (!prepared) return;
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: job.data.emergencyId },
      select: {
        id: true,
        brandId: true,
        status: true,
        finishedAt: true,
        endsAt: true,
        brand: { select: { application: { select: { id: true, appId: true, appSecret: true } } } },
        targets: {
          select: {
            id: true,
            offlineStatus: true,
            restoreStatus: true,
            offlineError: true,
            updatedAt: true,
            shop: { select: { id: true, appShopId: true } },
            events: {
              where: { type: RECONCILE_DETAIL_SLOT_EVENT },
              select: { occurredAt: true },
              orderBy: { occurredAt: 'desc' },
              take: 1,
            },
          },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (
      !emergency
      || emergency.finishedAt
      || !['offline', 'partial_success'].includes(emergency.status)
      || emergency.endsAt.getTime() <= Date.now()
    ) return;

    const application = emergency.brand.application;
    if (!application) {
      await this.recordReconciliationEmergencyFailure(
        emergency.id,
        'Brand has no linked application credentials during offline reconciliation',
      );
      return;
    }
    let appSecret: string;
    try {
      const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
      appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
    } catch {
      await this.recordReconciliationEmergencyFailure(
        emergency.id,
        'Application credential could not be decrypted during offline reconciliation',
      );
      return;
    }

    const selected = this.selectReconciliationBatch(emergency.targets, job.timestamp);
    let cursor = 0;
    const results: StoreEmergencyReconcileResult[] = [];
    const workerCount = Math.min(3, Math.max(1, selected.length));
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= selected.length) return;
        const target = selected[index];
        results.push(await this.reconcileTarget(
          emergency.id,
          emergency.brandId,
          target,
          application.id,
          application.appId,
          appSecret,
        ));
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await this.refreshReconciliationSummary(emergency.id, {
      appended: prepared.appended,
      checked: selected.length,
      reapplied: results.filter(result => result === 'reapplied').length,
      failed: results.filter(result => result === 'failed').length,
    });
  }

  private async prepareReconciliation(emergencyId: string) {
    const snapshot = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      select: { brandId: true },
    });
    if (!snapshot) return null;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(CAST(${snapshot.brandId} AS text), 0))
      `);
      const current = await tx.storeEmergency.findFirst({
        where: {
          id: emergencyId,
          status: { in: ['offline', 'partial_success'] },
          finishedAt: null,
          endsAt: { gt: new Date() },
        },
        select: { id: true, brandId: true, mode: true },
      });
      if (!current) return null;
      let appended = 0;
      if (current.mode === 'all_brand') {
        const shops = await tx.shop.findMany({
          where: { brandId: current.brandId, deletedAt: null },
          select: { id: true },
        });
        if (shops.length > 0) {
          const created = await tx.storeEmergencyTarget.createMany({
            data: shops.map(shop => ({
              emergencyId: current.id,
              shopId: shop.id,
              offlineStatus: 'pending',
              restoreStatus: 'not_required',
            })),
            skipDuplicates: true,
          });
          appended = created.count;
        }
        if (appended > 0) {
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: current.id,
              type: 'reconcile_targets_appended',
              phase: 'system',
              outcome: 'requested',
              source: 'worker',
              message: `${appended} newly discovered store(s) added to the all-brand emergency`,
              metadata: { appended },
            }),
          });
        }
      }
      return { brandId: current.brandId, appended };
    }, { maxWait: 10_000, timeout: 45_000 });
  }

  private selectReconciliationBatch(
    targets: StoreEmergencyReconcileTarget[],
    jobTimestamp: number,
  ): StoreEmergencyReconcileTarget[] {
    const latestReservationAt = (values: StoreEmergencyReconcileTarget[]) => values.reduce(
      (latest, target) => Math.max(latest, target.events[0]?.occurredAt.getTime() ?? Number.NEGATIVE_INFINITY),
      Number.NEGATIVE_INFINITY,
    );
    const leastRecentlyReserved = (values: StoreEmergencyReconcileTarget[]) => [...values].sort((left, right) => {
      const leftReservedAt = left.events[0]?.occurredAt.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightReservedAt = right.events[0]?.occurredAt.getTime() ?? Number.NEGATIVE_INFINITY;
      return leftReservedAt - rightReservedAt
        || left.updatedAt.getTime() - right.updatedAt.getTime()
        || left.id.localeCompare(right.id);
    })[0];
    const urgent = targets.filter(target => (
      target.offlineStatus !== 'done'
      || target.offlineError !== null
      || target.restoreStatus === 'required'
    ));
    const urgentIds = new Set(urgent.map(target => target.id));
    const healthy = targets.filter(target => !urgentIds.has(target.id));
    const lastUrgentReservation = latestReservationAt(urgent);
    const lastHealthyReservation = latestReservationAt(healthy);
    const sampleHealthy = urgent.length > 0 && healthy.length > 0 && (
      lastHealthyReservation === Number.NEGATIVE_INFINITY
        ? lastUrgentReservation !== Number.NEGATIVE_INFINITY
        : lastHealthyReservation <= jobTimestamp - RECONCILE_HEALTHY_SAMPLE_MINUTES * 60_000
    );
    const selectedPool = sampleHealthy || urgent.length === 0 ? healthy : urgent;
    if (selectedPool.length === 0) return [];
    return [leastRecentlyReserved(selectedPool)].slice(0, RECONCILE_BATCH_SIZE);
  }

  /**
   * DiDi enforces shop/detail as an application-wide one-request-per-minute
   * endpoint. The advisory lock serializes replicas while the durable event
   * keeps the cooldown across restarts and across emergencies sharing an app.
   */
  private async claimReconcileDetailSlot(
    emergencyId: string,
    brandId: string,
    targetId: string,
    applicationId: string,
  ): Promise<boolean> {
    return this.withReconcileTargetLock(brandId, targetId, 15_000, async tx => {
      if (!await this.reconcileStillLive(tx, emergencyId)) return false;
      const target = await tx.storeEmergencyTarget.findUnique({
        where: { id: targetId },
        select: { emergencyId: true, restoreStatus: true, updatedAt: true },
      });
      if (!target || target.emergencyId !== emergencyId) return false;
      if (
        ['required', 'running'].includes(target.restoreStatus)
        && target.updatedAt.getTime() > Date.now() - RECONCILE_DETAIL_COOLDOWN_MS
      ) return false;

      // This claim transaction performs only bounded database work. A short
      // blocking lock lets the rightful fair-turn contender proceed after a
      // non-selected peer releases the application lane.
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(CAST(${applicationId} AS text), 2))
      `);

      const reservedAt = new Date();
      const cutoff = new Date(reservedAt.getTime() - RECONCILE_DETAIL_COOLDOWN_MS);
      const recent = await tx.storeEmergencyEvent.findFirst({
        where: {
          type: RECONCILE_DETAIL_SLOT_EVENT,
          occurredAt: { gt: cutoff },
          metadata: { path: ['applicationId'], equals: applicationId },
        },
        select: { id: true },
        orderBy: { occurredAt: 'desc' },
      });
      if (recent) return false;

      const peers = await tx.storeEmergency.findMany({
        where: {
          status: { in: ['offline', 'partial_success'] },
          finishedAt: null,
          endsAt: { gt: reservedAt },
          brand: { applicationId },
          targets: { some: {} },
        },
        select: { id: true },
      });
      const peerIds = peers.map(peer => peer.id);
      if (!peerIds.includes(emergencyId)) return false;
      const reservations = await tx.storeEmergencyEvent.findMany({
        where: {
          emergencyId: { in: peerIds },
          type: RECONCILE_DETAIL_SLOT_EVENT,
          metadata: { path: ['applicationId'], equals: applicationId },
        },
        select: { emergencyId: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        distinct: ['emergencyId'],
      });
      const lastServed = new Map(reservations.map(event => [event.emergencyId, event.occurredAt.getTime()]));
      const nextEmergencyId = peers
        .map(peer => ({ id: peer.id, lastServedAt: lastServed.get(peer.id) ?? Number.NEGATIVE_INFINITY }))
        .sort((left, right) => left.lastServedAt - right.lastServedAt || left.id.localeCompare(right.id))[0]?.id;
      if (nextEmergencyId !== emergencyId) return false;

      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          targetId,
          type: RECONCILE_DETAIL_SLOT_EVENT,
          phase: 'system',
          outcome: 'requested',
          source: 'worker',
          message: 'Reserved the application-wide DiDi shop/detail reconciliation slot',
          metadata: { applicationId, cooldownMs: RECONCILE_DETAIL_COOLDOWN_MS },
          occurredAt: reservedAt,
        }),
      });
      return true;
    });
  }

  private async reconcileTarget(
    emergencyId: string,
    brandId: string,
    target: StoreEmergencyReconcileTarget,
    applicationId: string,
    appId: string,
    appSecret: string,
  ): Promise<StoreEmergencyReconcileResult> {
    if (
      ['required', 'running'].includes(target.restoreStatus)
      && target.updatedAt.getTime() > Date.now() - RECONCILE_DETAIL_COOLDOWN_MS
    ) return 'skipped';
    if (!await this.claimReconcileDetailSlot(emergencyId, brandId, target.id, applicationId)) {
      return 'skipped';
    }
    let authToken: string;
    try {
      authToken = await getAuthToken(
        appId,
        appSecret,
        target.shop.appShopId,
        AbortSignal.timeout(RECONCILE_AUTH_TIMEOUT_MS),
      );
    } catch (error) {
      await this.recordReconcileTargetFailure(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        error,
        'auth',
      );
      return 'failed';
    }

    try {
      const inspection = await this.inspectReconcileTarget(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        authToken,
      );
      if (typeof inspection === 'string') return inspection;
      return await this.executeReconcileWrite(inspection, authToken, target.shop.appShopId);
    } catch (error) {
      await this.recordReconcileTargetFailure(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        error,
        'locked_detail_or_write',
      );
      return 'failed';
    }
  }

  private async inspectReconcileTarget(
    emergencyId: string,
    brandId: string,
    targetId: string,
    appShopId: string,
    authToken: string,
  ): Promise<StoreEmergencyReconcileResult | StoreEmergencyReconcileLease> {
    return this.withReconcileTargetLock(brandId, targetId, 25_000, async tx => {
      if (!await this.reconcileStillLive(tx, emergencyId)) return 'skipped';
      const target = await tx.storeEmergencyTarget.findUnique({
        where: { id: targetId },
        select: {
          emergencyId: true,
          offlineStatus: true,
          restoreStatus: true,
          offlineError: true,
          offlineAt: true,
          restoreError: true,
          updatedAt: true,
        },
      });
      if (!target || target.emergencyId !== emergencyId) return 'skipped';
      if (
        ['required', 'running'].includes(target.restoreStatus)
        && target.updatedAt.getTime() > Date.now() - RECONCILE_DETAIL_COOLDOWN_MS
      ) return 'skipped';
      let remoteStatus: number;
      try {
        remoteStatus = await this.readStoreStatus(authToken, RECONCILE_READ_TIMEOUT_MS);
      } catch (error) {
        if (!isDidiDetailRateLimit(error)) throw error;
        this.logger.warn(
          `detail rate limit deferred reconciliation for app_shop_id ${appShopId}; target state was not changed`,
        );
        return 'skipped';
      }
      if (remoteStatus === 2) {
        const pendingVerification = ['required', 'running'].includes(target.restoreStatus);
        const owned = pendingVerification
          || (target.offlineStatus === 'done' && target.restoreStatus === 'pending');
        const restoreStatus = owned ? 'pending' : 'not_required';
        if (
          target.offlineStatus === 'done'
          && target.offlineError === null
          && target.restoreStatus === restoreStatus
          && target.restoreError === null
        ) return 'already_offline';
        const completedAt = new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1));
        const completed = await tx.storeEmergencyTarget.updateMany({
          where: { id: targetId, emergencyId, updatedAt: target.updatedAt },
          data: {
            offlineStatus: 'done',
            offlineError: null,
            offlineAt: target.offlineAt ?? completedAt,
            restoreStatus,
            restoreError: null,
            updatedAt: completedAt,
          },
        });
        if (completed.count === 0) return 'skipped';
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId,
            targetId,
            type: pendingVerification ? 'target_reconcile_succeeded' : 'target_reconcile_observed_offline',
            phase: 'shutdown',
            outcome: 'succeeded',
            source: 'worker',
            message: pendingVerification
              ? `Deferred offline verification succeeded for store ${appShopId}`
              : `Offline state reconciled for store ${appShopId} without a provider write`,
            metadata: {
              appShopId,
              providerWriteAttempted: false,
              providerWritePreviouslyAttempted: pendingVerification,
              remoteVerified: true,
              verificationSource: 'shop_detail',
              restoreOwnership: restoreStatus,
            },
            occurredAt: completedAt,
          }),
        });
        return 'already_offline';
      }
      if (remoteStatus !== 1) {
        throw new Error(`GET /v1/shop/shop/detail returned unsupported biz_status=${remoteStatus}`);
      }
      const leaseAt = new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1));
      const claimed = await tx.storeEmergencyTarget.updateMany({
        where: { id: targetId, emergencyId, updatedAt: target.updatedAt },
        data: {
          restoreStatus: 'required',
          restoreError: null,
          offlineAttempts: { increment: 1 },
          updatedAt: leaseAt,
        },
      });
      if (claimed.count === 0) return 'skipped';
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          targetId,
          type: 'target_reconcile_claimed',
          phase: 'shutdown',
          outcome: 'requested',
          source: 'worker',
          message: 'Online drift detected; durable shutdown ownership recorded before provider write',
          metadata: { ownershipDurable: true, remoteStatus, verificationPending: true },
          occurredAt: leaseAt,
        }),
      });
      return {
        emergencyId,
        brandId,
        targetId,
        updatedAt: leaseAt,
      };
    });
  }

  private async executeReconcileWrite(
    lease: StoreEmergencyReconcileLease,
    authToken: string,
    appShopId: string,
  ): Promise<StoreEmergencyReconcileResult> {
    return this.withReconcileTargetLock(lease.brandId, lease.targetId, 25_000, async tx => {
      if (!await this.reconcileStillLive(tx, lease.emergencyId)) return 'skipped';
      const target = await tx.storeEmergencyTarget.findFirst({
        where: {
          id: lease.targetId,
          emergencyId: lease.emergencyId,
          restoreStatus: 'required',
          updatedAt: lease.updatedAt,
        },
        select: { offlineAt: true },
      });
      if (!target) return 'skipped';

      try {
        const provider = await this.setStoreStatus(authToken, 2);
        const completedAt = new Date();
        const completed = await tx.storeEmergencyTarget.updateMany({
          where: {
            id: lease.targetId,
            emergencyId: lease.emergencyId,
            restoreStatus: 'required',
            updatedAt: lease.updatedAt,
          },
          data: {
            offlineStatus: 'done',
            offlineError: null,
            offlineAt: target.offlineAt ?? completedAt,
            restoreStatus: 'pending',
            restoreError: null,
            updatedAt: completedAt,
          },
        });
        if (completed.count === 0) return 'skipped';
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: lease.emergencyId,
            targetId: lease.targetId,
            type: 'target_reconcile_succeeded',
            phase: 'shutdown',
            outcome: 'succeeded',
            source: 'worker',
            message: `Offline drift corrected and confirmed for store ${appShopId}`,
            metadata: {
              appShopId,
              providerWriteAttempted: true,
              remoteVerified: true,
              verificationSource: 'setStatus_response',
              providerBizStatus: provider.bizStatus,
              providerAutoSwitch: provider.autoSwitch,
              providerSubBizStatus: provider.subBizStatus,
              ownershipDurable: true,
            },
            occurredAt: completedAt,
          }),
        });
        return 'reapplied';
      } catch (error) {
        const writeError = error instanceof Error ? error : new Error(String(error));
        const message = sanitizeEmergencyMessage(
          `${writeError.message}; provider result is unverified until the next reconciliation minute`,
        );
        const failedAt = new Date();
        const failed = await tx.storeEmergencyTarget.updateMany({
          where: {
            id: lease.targetId,
            emergencyId: lease.emergencyId,
            restoreStatus: 'required',
            updatedAt: lease.updatedAt,
          },
          data: {
            offlineStatus: 'failed',
            offlineError: RECONCILE_VERIFICATION_PENDING,
            restoreStatus: 'required',
            // Preserve the durable claim age. A later tick must perform the
            // single allowed detail read before deciding whether to retry.
            updatedAt: lease.updatedAt,
          },
        });
        if (failed.count > 0) {
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: lease.emergencyId,
              targetId: lease.targetId,
              type: 'target_reconcile_failed',
              phase: 'shutdown',
              outcome: 'failed',
              source: 'worker',
              message,
              metadata: {
                appShopId,
                stage: 'write',
                providerWriteAttempted: true,
                remoteVerified: false,
                verificationPending: true,
                ownershipDurable: true,
                retryable: true,
              },
              occurredAt: failedAt,
            }),
          });
        }
        return 'failed';
      }
    });
  }

  private async recordReconcileTargetFailure(
    emergencyId: string,
    brandId: string,
    targetId: string,
    appShopId: string,
    error: unknown,
    stage: string,
  ) {
    const message = sanitizeEmergencyMessage(error instanceof Error ? error.message : String(error));
    this.logger.error(`reconcile failed for app_shop_id ${appShopId}: ${message}`);
    try {
      await this.withReconcileTargetLock(brandId, targetId, 15_000, async tx => {
        if (!await this.reconcileStillLive(tx, emergencyId)) return;
        const target = await tx.storeEmergencyTarget.findUnique({
          where: { id: targetId },
          select: {
            emergencyId: true,
            offlineStatus: true,
            restoreStatus: true,
            offlineError: true,
            updatedAt: true,
          },
        });
        if (!target || target.emergencyId !== emergencyId) return;
        const failedAt = new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1));
        const updatedAt = target.restoreStatus === 'required' ? target.updatedAt : failedAt;
        const failedStatus = target.offlineStatus === 'done' ? 'done' : 'failed';
        const failed = await tx.storeEmergencyTarget.updateMany({
          where: { id: targetId, emergencyId, updatedAt: target.updatedAt },
          data: { offlineStatus: failedStatus, offlineError: message, updatedAt },
        });
        if (failed.count === 0 || (target.offlineStatus === failedStatus && target.offlineError === message)) return;
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId,
            targetId,
            type: 'target_reconcile_failed',
            phase: 'shutdown',
            outcome: 'failed',
            source: 'worker',
            message,
            metadata: { appShopId, stage, retryable: true },
            occurredAt: failedAt,
          }),
        });
      });
    } catch (auditError) {
      this.logger.error(`Could not persist reconciliation failure for ${appShopId}: ${(auditError as Error).message}`);
    }
  }

  private async refreshReconciliationSummary(
    emergencyId: string,
    metadata: { appended: number; checked: number; reapplied: number; failed: number },
  ) {
    await this.prisma.$transaction(async tx => {
      const snapshot = await tx.storeEmergency.findUnique({
        where: { id: emergencyId },
        select: { brandId: true },
      });
      if (!snapshot) return;
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(hashtextextended(CAST(${snapshot.brandId} AS text), 0))
      `);
      const current = await tx.storeEmergency.findUnique({
        where: { id: emergencyId },
        select: { status: true, errorMessage: true, updatedAt: true, finishedAt: true, endsAt: true },
      });
      if (
        !current
        || current.finishedAt
        || !['offline', 'partial_success'].includes(current.status)
        || current.endsAt.getTime() <= Date.now()
      ) return;
      const unhealthy = await tx.storeEmergencyTarget.count({
        where: {
          emergencyId,
          OR: [
            { offlineStatus: { not: 'done' } },
            { offlineError: { not: null } },
            { restoreStatus: { in: ['required', 'running'] } },
          ],
        },
      });
      const nextStatus = unhealthy > 0 ? 'partial_success' : 'offline';
      const nextError = unhealthy > 0
        ? `${unhealthy} store(s) do not currently have a verified offline state`
        : null;
      if (current.status === nextStatus && current.errorMessage === nextError) return;
      const changedAt = new Date();
      const changed = await tx.storeEmergency.updateMany({
        where: {
          id: emergencyId,
          status: current.status,
          updatedAt: current.updatedAt,
          finishedAt: null,
          endsAt: { gt: changedAt },
        },
        data: { status: nextStatus, errorMessage: nextError },
      });
      if (changed.count === 0) return;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          type: unhealthy > 0 ? 'reconciliation_partial' : 'reconciliation_healthy',
          phase: 'system',
          outcome: unhealthy > 0 ? 'partial' : 'succeeded',
          source: 'worker',
          message: nextError ?? 'All emergency targets have a verified offline state',
          metadata: { ...metadata, unhealthy },
          occurredAt: changedAt,
        }),
      });
    }, { timeout: 30_000 });
  }

  private async recordReconciliationEmergencyFailure(emergencyId: string, rawMessage: string) {
    const message = sanitizeEmergencyMessage(rawMessage);
    await this.prisma.$transaction(async tx => {
      const snapshot = await tx.storeEmergency.findUnique({
        where: { id: emergencyId },
        select: { brandId: true },
      });
      if (!snapshot) return;
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(hashtextextended(CAST(${snapshot.brandId} AS text), 0))
      `);
      const current = await tx.storeEmergency.findUnique({
        where: { id: emergencyId },
        select: { status: true, errorMessage: true, updatedAt: true, finishedAt: true, endsAt: true },
      });
      if (
        !current
        || current.finishedAt
        || !['offline', 'partial_success'].includes(current.status)
        || current.endsAt.getTime() <= Date.now()
      ) return;
      if (current.status === 'partial_success' && current.errorMessage === message) return;
      const failedAt = new Date();
      const changed = await tx.storeEmergency.updateMany({
        where: {
          id: emergencyId,
          status: current.status,
          updatedAt: current.updatedAt,
          finishedAt: null,
          endsAt: { gt: failedAt },
        },
        data: { status: 'partial_success', errorMessage: message },
      });
      if (changed.count === 0) return;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          type: 'reconciliation_failed',
          phase: 'system',
          outcome: 'failed',
          source: 'worker',
          message,
          metadata: { retryableNextMinute: true },
          occurredAt: failedAt,
        }),
      });
    });
  }

  private async withReconcileTargetLock<T>(
    brandId: string,
    targetId: string,
    timeout: number,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(hashtextextended(CAST(${brandId} AS text), 0))
      `);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(CAST(${targetId} AS text), 1))
      `);
      return operation(tx);
    }, { maxWait: 5_000, timeout });
  }

  private async reconcileStillLive(tx: Prisma.TransactionClient, emergencyId: string) {
    return tx.storeEmergency.findFirst({
      where: {
        id: emergencyId,
        status: { in: ['offline', 'partial_success'] },
        finishedAt: null,
        endsAt: { gt: new Date() },
      },
      select: { id: true },
    });
  }

  private async processTarget(
    emergencyId: string,
    targetId: string,
    shopId: string,
    appShopId: string,
    appId: string,
    appSecret: string,
    action: EmergencyAction,
    _initialRestoreStatus: string,
    actorId: string | null,
    triggerSource: string,
  ) {
    const phase = action === 'offline' ? 'shutdown' : 'restore';
    const startedAt = new Date();
    const claimed = await this.prisma.storeEmergencyTarget.updateMany({
      where: action === 'offline'
        ? {
          id: targetId,
          offlineStatus: 'pending',
          emergency: { id: emergencyId, status: 'running', finishedAt: null },
        }
        : {
          id: targetId,
          OR: [
            { restoreStatus: 'required' },
            { offlineStatus: 'done', restoreStatus: 'pending' },
          ],
          emergency: { id: emergencyId, status: 'restoring', finishedAt: null },
        },
      data: action === 'offline'
        ? {
          offlineStatus: 'running',
          offlineError: null,
          offlineAttempts: { increment: 1 },
          updatedAt: startedAt,
        }
        : {
          restoreStatus: 'running',
          restoreError: null,
          restoreAttempts: { increment: 1 },
          updatedAt: startedAt,
        },
    });
    if (claimed.count === 0) return;
    let lease: StoreEmergencyTargetLease = { emergencyId, targetId, action, updatedAt: startedAt };
    const target = await this.prisma.storeEmergencyTarget.findUnique({
      where: { id: targetId },
      select: { offlineAttempts: true, restoreAttempts: true },
    });
    const attempt = action === 'offline' ? target?.offlineAttempts : target?.restoreAttempts;
    await this.prisma.storeEmergencyEvent.create({
      data: emergencyEventData({
        emergencyId,
        targetId,
        type: action === 'offline' ? 'target_shutdown_started' : 'target_restore_started',
        phase,
        outcome: 'running',
        source: 'worker',
        actorId,
        attempt: attempt ?? 1,
        message: `${action === 'offline' ? 'Shutdown' : 'Reopening'} started for store ${appShopId}`,
        metadata: { triggerSource },
        occurredAt: startedAt,
      }),
    });
    try {
      const authToken = await getAuthToken(
        appId,
        appSecret,
        appShopId,
        AbortSignal.timeout(AUTH_TIMEOUT_MS),
      );

      if (action === 'offline') {
        // Every emergency OFF write is owned before it reaches DiDi. The
        // provider's detail endpoint is limited to one application-wide read
        // per minute, so it cannot be used as a per-store preflight.
        lease = await this.renewTargetLease(lease, { restoreStatus: 'required' });
      } else {
        lease = await this.renewTargetLease(lease);
      }
      await this.heartbeat(emergencyId, action);

      let provider: StoreStatusWriteResult;
      if (action === 'restore') {
        lease = await this.renewTargetLease(lease);
        await this.heartbeat(emergencyId, action);
        const permittedLease = lease;
        provider = await this.openingGuard.withOpeningPermit({
          shopId,
          allowedEmergencyId: emergencyId,
          operation: 'store_emergency_restore',
          validate: async tx => {
            const currentLease = await tx.storeEmergencyTarget.updateMany({
              where: this.leaseWhere(permittedLease),
              // A no-op CAS takes a row lock until the provider write ends,
              // so the watchdog cannot steal the exact lease after validation.
              data: { updatedAt: permittedLease.updatedAt },
            });
            if (currentLease.count === 0) throw new StoreEmergencyLeaseLostError();
          },
          execute: () => this.setStoreStatus(authToken, 1),
        });
      } else {
        lease = await this.renewTargetLease(lease);
        provider = await this.setStoreStatus(authToken, 2);
      }

      await this.completeTarget(lease, {
        actorId,
        appShopId,
        attempt: attempt ?? 1,
        triggerSource,
        preflightAlreadyDesired: false,
        provider,
        data: action === 'offline'
          ? {
            offlineStatus: 'done',
            offlineAt: new Date(),
            restoreStatus: 'pending',
            restoreError: null,
          }
          : { restoreStatus: 'done', restoredAt: new Date(), restoreError: null },
      });
    } catch (error) {
      const message = sanitizeEmergencyMessage((error as Error).message);
      if (error instanceof StoreEmergencyLeaseLostError) {
        this.logger.warn(`${action} lease lost for app_shop_id ${appShopId}; watchdog/newer worker owns the target`);
        return;
      }
      this.logger.error(`${action} failed for app_shop_id ${appShopId}: ${message}`);
      await this.failTarget(lease, {
        actorId,
        appShopId,
        attempt: attempt ?? 1,
        triggerSource,
        message,
      });
    }
  }

  private async setStoreStatus(authToken: string, bizStatus: 1 | 2): Promise<StoreStatusWriteResult> {
    const endpoint = 'POST /v1/shop/shop/setStatus';
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, biz_status: bizStatus, auto_switch: 1 }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
    const rawStatus = body.data?.biz_status ?? body.data?.bizStatus;
    if (typeof rawStatus !== 'boolean') {
      throw new Error(`${endpoint} returned errno=0 without a boolean data.biz_status; provider result is ambiguous`);
    }
    const confirmedStatus: 1 | 2 = rawStatus ? 1 : 2;
    if (confirmedStatus !== bizStatus) {
      throw new Error(
        `${endpoint} returned errno=0 but confirmed biz_status=${confirmedStatus}; expected ${bizStatus}`,
      );
    }
    const rawAutoSwitch = body.data?.auto_switch ?? body.data?.autoSwitch;
    const rawSubBizStatus = body.data?.sub_biz_status ?? body.data?.subBizStatus;
    const subBizStatus = Number(rawSubBizStatus);
    return {
      bizStatus: confirmedStatus,
      autoSwitch: typeof rawAutoSwitch === 'boolean' ? rawAutoSwitch : null,
      subBizStatus: Number.isFinite(subBizStatus) ? subBizStatus : null,
    };
  }

  private async readStoreStatus(authToken: string, timeoutMs: number): Promise<number> {
    const endpoint = 'GET /v1/shop/shop/detail';
    const response = await fetchWithEndpointContext(
      endpoint,
      `${DIDI_BASE}/v1/shop/shop/detail?auth_token=${encodeURIComponent(authToken)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
    const raw = body.data?.biz_status ?? body.data?.bizStatus;
    const status = raw === true ? 1 : raw === false ? 2 : Number(raw);
    if (!Number.isFinite(status)) throw new Error(`${endpoint} returned an invalid biz_status`);
    return status;
  }

  private async heartbeat(emergencyId: string, action: EmergencyAction): Promise<void> {
    await this.prisma.storeEmergency.updateMany({
      where: {
        id: emergencyId,
        status: action === 'offline' ? 'running' : 'restoring',
        finishedAt: null,
      },
      data: { updatedAt: new Date() },
    });
  }

  private leaseWhere(lease: StoreEmergencyTargetLease): Prisma.StoreEmergencyTargetWhereInput {
    return lease.action === 'offline'
      ? {
        id: lease.targetId,
        offlineStatus: 'running',
        updatedAt: lease.updatedAt,
        emergency: { id: lease.emergencyId, status: 'running', finishedAt: null },
      }
      : {
        id: lease.targetId,
        restoreStatus: 'running',
        updatedAt: lease.updatedAt,
        emergency: { id: lease.emergencyId, status: 'restoring', finishedAt: null },
      };
  }

  private async renewTargetLease(
    lease: StoreEmergencyTargetLease,
    data: Prisma.StoreEmergencyTargetUpdateManyMutationInput = {},
  ): Promise<StoreEmergencyTargetLease> {
    const nextLeaseAt = new Date(Math.max(Date.now(), lease.updatedAt.getTime() + 1));
    const renewed = await this.prisma.storeEmergencyTarget.updateMany({
      where: this.leaseWhere(lease),
      data: { ...data, updatedAt: nextLeaseAt },
    });
    if (renewed.count === 0) throw new StoreEmergencyLeaseLostError();
    return { ...lease, updatedAt: nextLeaseAt };
  }

  private async completeTarget(
    lease: StoreEmergencyTargetLease,
    input: {
      actorId: string | null;
      appShopId: string;
      attempt: number;
      triggerSource: string;
      preflightAlreadyDesired: boolean;
      provider?: StoreStatusWriteResult;
      data: Prisma.StoreEmergencyTargetUpdateManyMutationInput;
    },
  ): Promise<void> {
    const completedAt = new Date();
    const completed = await this.prisma.$transaction(async tx => {
      const updated = await tx.storeEmergencyTarget.updateMany({
        where: this.leaseWhere(lease),
        data: { ...input.data, updatedAt: completedAt },
      });
      if (updated.count === 0) return false;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: lease.emergencyId,
          targetId: lease.targetId,
          type: lease.action === 'offline' ? 'target_shutdown_succeeded' : 'target_restore_succeeded',
          phase: lease.action === 'offline' ? 'shutdown' : 'restore',
          outcome: 'succeeded',
          source: 'worker',
          actorId: input.actorId,
          attempt: input.attempt,
          message: input.preflightAlreadyDesired
            ? `${lease.action === 'offline' ? 'Shutdown' : 'Reopening'} already satisfied remotely for store ${input.appShopId}`
            : `${lease.action === 'offline' ? 'Shutdown' : 'Reopening'} verified for store ${input.appShopId}`,
          metadata: {
            triggerSource: input.triggerSource,
            providerWriteAttempted: !input.preflightAlreadyDesired,
            remoteVerified: true,
            verificationSource: input.preflightAlreadyDesired ? 'shop_detail' : 'setStatus_response',
            providerBizStatus: input.provider?.bizStatus ?? null,
            providerAutoSwitch: input.provider?.autoSwitch ?? null,
            providerSubBizStatus: input.provider?.subBizStatus ?? null,
          },
          occurredAt: completedAt,
        }),
      });
      return true;
    });
    if (!completed) throw new StoreEmergencyLeaseLostError();
  }

  private async failTarget(
    lease: StoreEmergencyTargetLease,
    input: {
      actorId: string | null;
      appShopId: string;
      attempt: number;
      triggerSource: string;
      message: string;
    },
  ): Promise<void> {
    const failedAt = new Date();
    await this.prisma.$transaction(async tx => {
      const failed = await tx.storeEmergencyTarget.updateMany({
        where: this.leaseWhere(lease),
        data: lease.action === 'offline'
          ? { offlineStatus: 'failed', offlineError: input.message, updatedAt: failedAt }
          : { restoreStatus: 'failed', restoreError: input.message, updatedAt: failedAt },
      });
      if (failed.count === 0) return;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: lease.emergencyId,
          targetId: lease.targetId,
          type: lease.action === 'offline' ? 'target_shutdown_failed' : 'target_restore_failed',
          phase: lease.action === 'offline' ? 'shutdown' : 'restore',
          outcome: 'failed',
          source: 'worker',
          actorId: input.actorId,
          attempt: input.attempt,
          message: input.message,
          metadata: { triggerSource: input.triggerSource, appShopId: input.appShopId },
          occurredAt: failedAt,
        }),
      });
    });
  }

  private async finalize(
    emergencyId: string,
    action: EmergencyAction,
    job: Job<StoreEmergencyJobData>,
    actionAttempt: number,
  ) {
    const [emergency, grouped] = await Promise.all([
      this.prisma.storeEmergency.findUnique({ where: { id: emergencyId } }),
      this.prisma.storeEmergencyTarget.groupBy({
        by: ['offlineStatus', 'restoreStatus'],
        where: { emergencyId },
        _count: { _all: true },
      }),
    ]);
    if (!emergency) return;
    const now = new Date();
    const actorId = job.data.actorId ?? null;
    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
    const shutdownInProgress = grouped
      .filter(row => ['pending', 'running'].includes(row.offlineStatus))
      .reduce((sum, row) => sum + row._count._all, 0);
    const restoreInProgress = grouped
      .filter(row => ['required', 'running'].includes(row.restoreStatus)
        || (row.offlineStatus === 'done' && row.restoreStatus === 'pending'))
      .reduce((sum, row) => sum + row._count._all, 0);
    if ((action === 'offline' && shutdownInProgress > 0) || (action === 'restore' && restoreInProgress > 0)) {
      await this.prisma.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          type: 'finalization_deferred',
          phase: 'system',
          outcome: 'skipped',
          source: 'worker',
          actorId,
          attempt: actionAttempt,
          message: `Finalization deferred while ${action === 'offline' ? shutdownInProgress : restoreInProgress} store(s) are still processing`,
          metadata: { action, shutdownInProgress, restoreInProgress, jobId: String(job.id ?? '') },
          occurredAt: now,
        }),
      });
      return;
    }

    if (action === 'offline') {
      const succeeded = grouped
        .filter(row => row.offlineStatus === 'done')
        .reduce((sum, row) => sum + row._count._all, 0);
      const ambiguousOwned = grouped
        .filter(row => row.offlineStatus !== 'done' && ['required', 'running'].includes(row.restoreStatus))
        .reduce((sum, row) => sum + row._count._all, 0);
      const failed = total - succeeded;
      const unownedFailed = Math.max(0, total - succeeded - ambiguousOwned);
      const status = succeeded === total
        ? 'offline'
        : succeeded > 0 || ambiguousOwned > 0 ? 'partial_success' : 'failed';
      const message = failed > 0
        ? `${succeeded}/${total} store(s) confirmed offline; ${ambiguousOwned} unverified shutdown result(s) remain protected; ${unownedFailed} failure(s) without shutdown ownership`
        : null;
      await this.prisma.$transaction(async tx => {
        const finalized = await tx.storeEmergency.updateMany({
          where: { id: emergencyId, status: 'running', finishedAt: null },
          data: {
            status,
            shutdownFinishedAt: now,
            ...(succeeded > 0 && !emergency.offlineAt ? { offlineAt: now } : {}),
            finishedAt: succeeded === 0 && ambiguousOwned === 0 ? now : null,
            errorMessage: message,
          },
        });
        if (finalized.count === 0) return;
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId,
            type: status === 'offline' ? 'shutdown_completed' : status === 'partial_success' ? 'shutdown_partial' : 'shutdown_failed',
            phase: 'shutdown',
            outcome: status === 'offline' ? 'succeeded' : status === 'partial_success' ? 'partial' : 'failed',
            source: 'worker',
            actorId,
            attempt: actionAttempt,
            message: message ?? `All ${succeeded} store(s) were turned off`,
            metadata: {
              total,
              succeeded,
              failed,
              ambiguousOwned,
              unownedFailed,
              retry: job.data.retry === true,
            },
            occurredAt: now,
          }),
        });
      });
      return;
    }

    const offlineSucceeded = grouped
      .filter(row => row.offlineStatus === 'done')
      .reduce((sum, row) => sum + row._count._all, 0);
    const restoreNotRequired = grouped
      .filter(row => row.offlineStatus === 'done' && row.restoreStatus === 'not_required')
      .reduce((sum, row) => sum + row._count._all, 0);
    const restoreRequired = grouped
      .filter(row => row.restoreStatus !== 'not_required' && (
        row.offlineStatus === 'done'
        || ['required', 'running', 'done', 'failed'].includes(row.restoreStatus)
      ))
      .reduce((sum, row) => sum + row._count._all, 0);
    const restored = grouped
      .filter(row => row.restoreStatus === 'done')
      .reduce((sum, row) => sum + row._count._all, 0);
    const restoreFailed = grouped
      .filter(row => row.restoreStatus === 'failed')
      .reduce((sum, row) => sum + row._count._all, 0);
    const status = restored === restoreRequired ? 'restored' : restored > 0 ? 'partial_restored' : 'restore_failed';
    const message = restoreFailed > 0 || offlineSucceeded < total
      ? `${restored}/${restoreRequired} store(s) requiring reopening restored; ${restoreNotRequired} already-offline store(s) left untouched; ${restoreFailed} restore failure(s); ${total - offlineSucceeded} store(s) were never turned off`
      : null;
    await this.prisma.$transaction(async tx => {
      const finalized = await tx.storeEmergency.updateMany({
        where: { id: emergencyId, status: 'restoring', finishedAt: null },
        data: {
          status,
          restoreFinishedAt: now,
          ...(restored > 0 && !emergency.restoredAt ? { restoredAt: now } : {}),
          finishedAt: now,
          errorMessage: message,
        },
      });
      if (finalized.count === 0) return;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          type: status === 'restored' ? 'restore_completed' : status === 'partial_restored' ? 'restore_partial' : 'restore_failed',
          phase: 'restore',
          outcome: status === 'restored' ? 'succeeded' : status === 'partial_restored' ? 'partial' : 'failed',
          source: 'worker',
          actorId,
          attempt: actionAttempt,
          message: message ?? (restoreRequired === 0
            ? `No stores required reopening; ${restoreNotRequired} pre-existing closure(s) preserved`
            : `All ${restored} store(s) requiring reopening were reopened`),
          metadata: {
            total,
            offlineSucceeded,
            restoreRequired,
            restoreNotRequired,
            restored,
            failed: restoreFailed,
            neverTurnedOff: total - offlineSucceeded,
            retry: job.data.retry === true,
          },
          occurredAt: now,
        }),
      });
    });
  }

  private async failEmergency(
    emergencyId: string,
    action: EmergencyAction,
    rawMessage: string,
    job?: Job<StoreEmergencyJobData>,
    actionAttempt?: number,
  ) {
    const message = sanitizeEmergencyMessage(rawMessage);
    const failedAt = new Date();
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      include: {
        targets: {
          where: action === 'offline'
            ? { offlineStatus: { in: ['pending', 'running'] } }
            : {
              OR: [
                { offlineStatus: 'done', restoreStatus: { in: ['pending', 'running', 'required'] } },
                { restoreStatus: { in: ['running', 'required'] } },
              ],
            },
          select: { id: true, offlineAttempts: true, restoreAttempts: true },
        },
      },
    });
    if (!emergency) return;
    const actorId = job?.data.actorId ?? null;
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.storeEmergency.updateMany({
        where: action === 'offline'
          ? { id: emergencyId, status: { in: ['pending', 'running'] }, finishedAt: null }
          : { id: emergencyId, status: 'restoring', finishedAt: null },
        data: { errorMessage: message },
      });
      if (claimed.count === 0) return;
      if (action === 'offline') {
        await tx.storeEmergencyTarget.updateMany({
          where: { emergencyId, offlineStatus: { in: ['pending', 'running'] } },
          data: { offlineStatus: 'failed', offlineError: message },
        });
      } else {
        // A global failure before a target lease is claimed must not erase the
        // durable ownership marker. Only a verified shutdown can be downgraded
        // to `failed`; ambiguous owned closures remain `required` and retryable.
        await tx.storeEmergencyTarget.updateMany({
          where: {
            emergencyId,
            offlineStatus: 'done',
            restoreStatus: { in: ['pending', 'running', 'required'] },
          },
          data: { restoreStatus: 'failed', restoreError: message },
        });
        await tx.storeEmergencyTarget.updateMany({
          where: {
            emergencyId,
            offlineStatus: { not: 'done' },
            restoreStatus: { in: ['running', 'required'] },
          },
          data: { restoreStatus: 'required', restoreError: message },
        });
      }
      const failedTargets = await tx.storeEmergencyTarget.findMany({
        where: action === 'offline'
          ? {
              id: { in: emergency.targets.map(target => target.id) },
              offlineStatus: 'failed',
              offlineError: message,
            }
          : {
              id: { in: emergency.targets.map(target => target.id) },
              restoreStatus: { in: ['failed', 'required'] },
              restoreError: message,
            },
        select: { id: true, offlineAttempts: true, restoreAttempts: true },
      });
      const grouped = await tx.storeEmergencyTarget.groupBy({
        by: ['offlineStatus', 'restoreStatus'],
        where: { emergencyId },
        _count: { _all: true },
      });
      const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
      const shutdownSucceeded = grouped
        .filter(row => row.offlineStatus === 'done')
        .reduce((sum, row) => sum + row._count._all, 0);
      const shutdownAmbiguous = grouped
        .filter(row => row.offlineStatus !== 'done' && ['required', 'running'].includes(row.restoreStatus))
        .reduce((sum, row) => sum + row._count._all, 0);
      const restored = grouped
        .filter(row => row.restoreStatus === 'done')
        .reduce((sum, row) => sum + row._count._all, 0);
      const restoreNotRequired = grouped
        .filter(row => row.offlineStatus === 'done' && row.restoreStatus === 'not_required')
        .reduce((sum, row) => sum + row._count._all, 0);
      const restoreRequired = grouped
        .filter(row => row.restoreStatus !== 'not_required' && (
          row.offlineStatus === 'done'
          || ['required', 'running', 'done', 'failed'].includes(row.restoreStatus)
        ))
        .reduce((sum, row) => sum + row._count._all, 0);
      const derivedStatus = action === 'offline'
        ? shutdownSucceeded === total && total > 0
          ? 'offline'
          : shutdownSucceeded > 0 || shutdownAmbiguous > 0 ? 'partial_success' : 'failed'
        : restored === restoreRequired
          ? 'restored'
          : restored > 0 ? 'partial_restored' : 'restore_failed';
      const outcome = derivedStatus === 'offline' || derivedStatus === 'restored'
        ? 'succeeded'
        : derivedStatus === 'partial_success' || derivedStatus === 'partial_restored'
          ? 'partial'
          : 'failed';
      await tx.storeEmergency.updateMany({
        where: action === 'offline'
          ? { id: emergencyId, status: { in: ['pending', 'running'] }, finishedAt: null }
          : { id: emergencyId, status: 'restoring', finishedAt: null },
        data: {
          status: derivedStatus,
          errorMessage: message,
          ...(action === 'offline' ? { shutdownFinishedAt: failedAt } : { restoreFinishedAt: failedAt }),
          ...(action === 'offline' && shutdownSucceeded > 0 && !emergency.offlineAt ? { offlineAt: failedAt } : {}),
          ...(action === 'restore' && restored > 0 && !emergency.restoredAt ? { restoredAt: failedAt } : {}),
          finishedAt: action === 'offline' && (shutdownSucceeded > 0 || shutdownAmbiguous > 0)
            ? null
            : failedAt,
        },
      });
      for (let index = 0; index < failedTargets.length; index += 500) {
        const targetBatch = failedTargets.slice(index, index + 500);
        await tx.storeEmergencyEvent.createMany({
          data: targetBatch.map(target => emergencyEventData({
            emergencyId,
            targetId: target.id,
            type: action === 'offline' ? 'target_shutdown_failed' : 'target_restore_failed',
            phase: action === 'offline' ? 'shutdown' : 'restore',
            outcome: 'failed',
            source: 'worker',
            actorId,
            attempt: (action === 'offline' ? target.offlineAttempts : target.restoreAttempts) || null,
            message,
            metadata: { globalFailure: true, triggerSource: job?.data.source ?? 'system' },
            occurredAt: failedAt,
          })),
        });
      }
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          type: action === 'offline'
            ? derivedStatus === 'offline' ? 'shutdown_completed' : derivedStatus === 'partial_success' ? 'shutdown_partial' : 'shutdown_failed'
            : derivedStatus === 'restored' ? 'restore_completed' : derivedStatus === 'partial_restored' ? 'restore_partial' : 'restore_failed',
          phase: action === 'offline' ? 'shutdown' : 'restore',
          outcome,
          source: 'worker',
          actorId,
          attempt: actionAttempt ?? null,
          message,
          metadata: {
            globalFailure: true,
            affectedTargets: failedTargets.length,
            total,
            shutdownSucceeded,
            shutdownAmbiguous,
            restoreRequired,
            restoreNotRequired,
            restored,
            derivedStatus,
            triggerSource: job?.data.source ?? 'system',
            jobId: String(job?.id ?? ''),
          },
          occurredAt: failedAt,
        }),
      });
    }, { timeout: 30_000 });
  }

  private async recordSkippedJob(
    emergencyId: string,
    action: EmergencyAction,
    currentStatus: string,
    job: Job<StoreEmergencyJobData>,
  ) {
    await this.prisma.storeEmergencyEvent.create({
      data: emergencyEventData({
        emergencyId,
        type: 'job_skipped',
        phase: 'system',
        outcome: 'skipped',
        source: 'worker',
        actorId: job.data.actorId ?? null,
        attempt: job.attemptsMade + 1,
        message: `Skipped ${action} job because emergency status is ${currentStatus}`,
        metadata: { action, currentStatus, jobId: String(job.id ?? '') },
      }),
    });
  }

  @OnWorkerEvent('failed')
  async failed(job: Job<StoreEmergencyJobData> | undefined, error: Error) {
    if (!job) return;
    const message = sanitizeEmergencyMessage(error.message);
    this.logger.error(
      `Emergency worker job ${String(job.id ?? '')} failed; watchdog will recover leases: ${message}`,
    );
    try {
      await this.prisma.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: job.data.emergencyId,
          type: 'worker_failed',
          phase: 'system',
          outcome: 'failed',
          source: 'worker',
          actorId: job.data.actorId ?? null,
          attempt: job.attemptsMade + 1,
          message,
          metadata: {
            action: job.data.action,
            jobId: String(job.id ?? ''),
            watchdogRecoveryExpected: true,
          },
        }),
      });
    } catch (auditError) {
      this.logger.error(`Could not persist emergency worker failure audit: ${(auditError as Error).message}`);
    }
  }
}
