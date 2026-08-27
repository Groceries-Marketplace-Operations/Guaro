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
  previousOfflineStatus: string;
  previousRestoreStatus: string;
}

interface StoreEmergencyReconcileTarget {
  id: string;
  offlineStatus: string;
  restoreStatus: string;
  offlineError: string | null;
  updatedAt: Date;
  shop: { id: string; appShopId: string };
}

type StoreEmergencyReconcileResult = 'already_offline' | 'reapplied' | 'failed' | 'skipped';

const AUTH_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 8_000;
const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 750;
const RECONCILE_AUTH_TIMEOUT_MS = 10_000;
const RECONCILE_READ_TIMEOUT_MS = 8_000;
const RECONCILE_VERIFY_TIMEOUT_MS = 18_000;
const RECONCILE_BATCH_SIZE = 30;
const RECONCILE_LEASE_MS = 50_000;

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
        brand: { select: { application: { select: { appId: true, appSecret: true } } } },
        targets: {
          select: {
            id: true,
            offlineStatus: true,
            restoreStatus: true,
            offlineError: true,
            updatedAt: true,
            shop: { select: { id: true, appShopId: true } },
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
    const minuteBucket = Math.floor(jobTimestamp / 60_000);
    const urgent = targets.filter(target => (
      target.offlineStatus !== 'done'
      || target.offlineError !== null
      || target.restoreStatus === 'required'
    ));
    const urgentIds = new Set(urgent.map(target => target.id));
    const healthy = targets.filter(target => !urgentIds.has(target.id));
    const healthyReserve = urgent.length > 0 && healthy.length > 0
      ? Math.min(10, healthy.length)
      : Math.min(RECONCILE_BATCH_SIZE, healthy.length);
    let urgentLimit = Math.min(urgent.length, RECONCILE_BATCH_SIZE - healthyReserve);
    let healthyLimit = Math.min(healthy.length, RECONCILE_BATCH_SIZE - urgentLimit);
    urgentLimit = Math.min(urgent.length, RECONCILE_BATCH_SIZE - healthyLimit);
    const window = (values: StoreEmergencyReconcileTarget[], limit: number) => {
      if (limit === 0 || values.length === 0) return [];
      const chunkCount = Math.ceil(values.length / limit);
      const start = (minuteBucket % chunkCount) * limit;
      return values.slice(start, start + limit);
    };
    return [...window(urgent, urgentLimit), ...window(healthy, healthyLimit)];
  }

  private async reconcileTarget(
    emergencyId: string,
    brandId: string,
    target: StoreEmergencyReconcileTarget,
    appId: string,
    appSecret: string,
  ): Promise<StoreEmergencyReconcileResult> {
    let authToken: string;
    let remoteStatus: number;
    try {
      authToken = await getAuthToken(
        appId,
        appSecret,
        target.shop.appShopId,
        AbortSignal.timeout(RECONCILE_AUTH_TIMEOUT_MS),
      );
      remoteStatus = await this.readStoreStatus(authToken, RECONCILE_READ_TIMEOUT_MS);
    } catch (error) {
      await this.recordReconcileTargetFailure(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        error,
        'preflight',
      );
      return 'failed';
    }

    if (remoteStatus === 2) {
      try {
        const lockedResult = await this.completeAlreadyOfflineReconcile(
          emergencyId,
          brandId,
          target.id,
          target.shop.appShopId,
          authToken,
        );
        if (lockedResult !== 'online') return lockedResult;
        remoteStatus = 1;
      } catch (error) {
        await this.recordReconcileTargetFailure(
          emergencyId,
          brandId,
          target.id,
          target.shop.appShopId,
          error,
          'locked_preflight',
        );
        return 'failed';
      }
    }
    if (remoteStatus !== 1) {
      await this.recordReconcileTargetFailure(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        new Error(`GET /v1/shop/shop/detail returned unsupported biz_status=${remoteStatus}`),
        'preflight',
      );
      return 'failed';
    }

    try {
      const lease = await this.claimReconcileLease(emergencyId, brandId, target.id);
      if (!lease) return 'skipped';
      return await this.executeReconcileWrite(lease, authToken, target.shop.appShopId);
    } catch (error) {
      await this.recordReconcileTargetFailure(
        emergencyId,
        brandId,
        target.id,
        target.shop.appShopId,
        error,
        'claim_or_write',
      );
      return 'failed';
    }
  }

  private async completeAlreadyOfflineReconcile(
    emergencyId: string,
    brandId: string,
    targetId: string,
    appShopId: string,
    authToken: string,
  ): Promise<StoreEmergencyReconcileResult | 'online'> {
    return this.withReconcileTargetLock(brandId, targetId, 15_000, async tx => {
      if (!await this.reconcileStillLive(tx, emergencyId)) return 'skipped';
      const lockedRemoteStatus = await this.readStoreStatus(authToken, RECONCILE_READ_TIMEOUT_MS);
      if (lockedRemoteStatus === 1) return 'online';
      if (lockedRemoteStatus !== 2) {
        throw new Error(
          `GET /v1/shop/shop/detail returned unsupported biz_status=${lockedRemoteStatus}`,
        );
      }
      const target = await tx.storeEmergencyTarget.findUnique({
        where: { id: targetId },
        select: {
          emergencyId: true,
          offlineStatus: true,
          restoreStatus: true,
          offlineError: true,
          offlineAt: true,
          updatedAt: true,
        },
      });
      if (!target || target.emergencyId !== emergencyId) return 'skipped';
      const owned = target.restoreStatus === 'required'
        || target.restoreStatus === 'running'
        || (target.offlineStatus === 'done' && target.restoreStatus === 'pending');
      const restoreStatus = owned ? 'pending' : 'not_required';
      if (
        target.offlineStatus === 'done'
        && target.offlineError === null
        && target.restoreStatus === restoreStatus
      ) return 'already_offline';
      const completedAt = new Date();
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
          type: 'target_reconcile_observed_offline',
          phase: 'shutdown',
          outcome: 'succeeded',
          source: 'worker',
          message: `Offline state reconciled for store ${appShopId} without a provider write`,
          metadata: { appShopId, providerWriteAttempted: false, restoreOwnership: restoreStatus },
          occurredAt: completedAt,
        }),
      });
      return 'already_offline';
    });
  }

  private async claimReconcileLease(
    emergencyId: string,
    brandId: string,
    targetId: string,
  ): Promise<StoreEmergencyReconcileLease | null> {
    return this.withReconcileTargetLock(brandId, targetId, 15_000, async tx => {
      if (!await this.reconcileStillLive(tx, emergencyId)) return null;
      const target = await tx.storeEmergencyTarget.findUnique({
        where: { id: targetId },
        select: {
          emergencyId: true,
          offlineStatus: true,
          restoreStatus: true,
          updatedAt: true,
        },
      });
      if (!target || target.emergencyId !== emergencyId) return null;
      if (
        ['required', 'running'].includes(target.restoreStatus)
        && target.updatedAt.getTime() > Date.now() - RECONCILE_LEASE_MS
      ) return null;
      const leaseAt = new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1));
      const claimed = await tx.storeEmergencyTarget.updateMany({
        where: { id: targetId, emergencyId, updatedAt: target.updatedAt },
        data: {
          restoreStatus: 'required',
          restoreError: null,
          offlineError: null,
          offlineAttempts: { increment: 1 },
          updatedAt: leaseAt,
        },
      });
      if (claimed.count === 0) return null;
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId,
          targetId,
          type: 'target_reconcile_claimed',
          phase: 'shutdown',
          outcome: 'requested',
          source: 'worker',
          message: 'Online drift detected; durable shutdown ownership recorded before retry',
          metadata: { ownershipDurable: true },
          occurredAt: leaseAt,
        }),
      });
      return {
        emergencyId,
        brandId,
        targetId,
        updatedAt: leaseAt,
        previousOfflineStatus: target.offlineStatus,
        previousRestoreStatus: target.restoreStatus,
      };
    });
  }

  private async executeReconcileWrite(
    lease: StoreEmergencyReconcileLease,
    authToken: string,
    appShopId: string,
  ): Promise<StoreEmergencyReconcileResult> {
    return this.withReconcileTargetLock(lease.brandId, lease.targetId, 45_000, async tx => {
      if (!await this.reconcileStillLive(tx, lease.emergencyId)) return 'skipped';
      const target = await tx.storeEmergencyTarget.findFirst({
        where: {
          id: lease.targetId,
          emergencyId: lease.emergencyId,
          restoreStatus: 'required',
          updatedAt: lease.updatedAt,
        },
        select: { offlineStatus: true, offlineAt: true },
      });
      if (!target) return 'skipped';

      let providerWriteAttempted = false;
      let writeError: Error | null = null;
      try {
        const currentRemoteStatus = await this.readStoreStatus(authToken, RECONCILE_READ_TIMEOUT_MS);
        if (currentRemoteStatus === 1) {
          providerWriteAttempted = true;
          try {
            await this.setStoreStatus(authToken, 2);
          } catch (error) {
            writeError = error instanceof Error ? error : new Error(String(error));
          }
          await this.verifyStoreStatus(authToken, 2, RECONCILE_VERIFY_TIMEOUT_MS);
        } else if (currentRemoteStatus !== 2) {
          throw new Error(
            `GET /v1/shop/shop/detail returned unsupported biz_status=${currentRemoteStatus}`,
          );
        }

        const completedAt = new Date();
        const previouslyOwned = ['required', 'running'].includes(lease.previousRestoreStatus)
          || (lease.previousOfflineStatus === 'done' && lease.previousRestoreStatus === 'pending');
        const restoreStatus = providerWriteAttempted || previouslyOwned ? 'pending' : 'not_required';
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
            restoreStatus,
            restoreError: null,
            updatedAt: completedAt,
          },
        });
        if (completed.count === 0) return 'skipped';
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: lease.emergencyId,
            targetId: lease.targetId,
            type: providerWriteAttempted ? 'target_reconcile_succeeded' : 'target_reconcile_observed_offline',
            phase: 'shutdown',
            outcome: 'succeeded',
            source: 'worker',
            message: providerWriteAttempted
              ? `Offline drift corrected and verified for store ${appShopId}`
              : `Store ${appShopId} became offline before the reconciliation write`,
            metadata: {
              appShopId,
              providerWriteAttempted,
              remoteVerified: true,
              postReturnedError: Boolean(writeError),
              ownershipDurable: true,
            },
            occurredAt: completedAt,
          }),
        });
        return providerWriteAttempted ? 'reapplied' : 'already_offline';
      } catch (error) {
        const verificationError = error instanceof Error ? error : new Error(String(error));
        const message = sanitizeEmergencyMessage(writeError
          ? `${writeError.message}; provider result remained unverified: ${verificationError.message}`
          : verificationError.message);
        const failedAt = new Date();
        const previousOwnership = ['required', 'running'].includes(lease.previousRestoreStatus)
          ? 'required'
          : lease.previousOfflineStatus === 'done' && lease.previousRestoreStatus === 'pending'
            ? 'pending'
            : 'not_required';
        const restoreStatus = providerWriteAttempted ? 'required' : previousOwnership;
        const failed = await tx.storeEmergencyTarget.updateMany({
          where: {
            id: lease.targetId,
            emergencyId: lease.emergencyId,
            restoreStatus: 'required',
            updatedAt: lease.updatedAt,
          },
          data: {
            offlineStatus: target.offlineStatus === 'done' ? 'done' : 'failed',
            offlineError: message,
            restoreStatus,
            // Preserve the durable lease age so the next minute can retry
            // immediately instead of extending a failed ownership claim.
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
                stage: 'write_verify',
                providerWriteAttempted,
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
    initialRestoreStatus: string,
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
      select: { offlineAttempts: true, restoreAttempts: true, restoreStatus: true },
    });
    const attempt = action === 'offline' ? target?.offlineAttempts : target?.restoreAttempts;
    const restoreOwnershipAtClaim = target?.restoreStatus ?? initialRestoreStatus;
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
      const initialRemoteStatus = await this.readStoreStatus(authToken, READ_TIMEOUT_MS);

      if (action === 'offline' && initialRemoteStatus === 2) {
        await this.completeTarget(lease, {
          actorId,
          appShopId,
          attempt: attempt ?? 1,
          triggerSource,
          preflightAlreadyDesired: true,
          data: {
            offlineStatus: 'done',
            offlineAt: new Date(),
            restoreStatus: restoreOwnershipAtClaim === 'required' ? 'pending' : 'not_required',
            restoreError: null,
          },
        });
        return;
      }
      if (action === 'restore' && initialRemoteStatus === 1) {
        await this.completeTarget(lease, {
          actorId,
          appShopId,
          attempt: attempt ?? 1,
          triggerSource,
          preflightAlreadyDesired: true,
          data: { restoreStatus: 'done', restoredAt: new Date(), restoreError: null },
        });
        return;
      }
      const expectedInitialStatus = action === 'offline' ? 1 : 2;
      if (initialRemoteStatus !== expectedInitialStatus) {
        throw new Error(
          `GET /v1/shop/shop/detail returned unsupported biz_status=${initialRemoteStatus}; provider write was not attempted`,
        );
      }

      if (action === 'offline') {
        // Ownership must be durable before the OFF request. If the worker dies
        // after DiDi applies it, recovery can distinguish stores that Guaro owns.
        lease = await this.renewTargetLease(lease, { restoreStatus: 'required' });
      } else {
        lease = await this.renewTargetLease(lease);
      }
      await this.heartbeat(emergencyId, action);

      let writeError: Error | null = null;
      try {
        if (action === 'restore') {
          await this.openingGuard.withOpeningPermit({
            shopId,
            allowedEmergencyId: emergencyId,
            operation: 'store_emergency_restore',
            execute: async () => {
              lease = await this.renewTargetLease(lease);
              await this.heartbeat(emergencyId, action);
              await this.setStoreStatus(authToken, 1);
            },
          });
        } else {
          lease = await this.renewTargetLease(lease);
          await this.setStoreStatus(authToken, 2);
        }
      } catch (error) {
        writeError = error instanceof Error ? error : new Error(String(error));
      }
      if (writeError instanceof StoreEmergencyLeaseLostError) throw writeError;

      try {
        await this.verifyStoreStatus(authToken, action === 'offline' ? 2 : 1);
      } catch (verificationError) {
        const verificationMessage = verificationError instanceof Error
          ? verificationError.message
          : String(verificationError);
        throw new Error(writeError
          ? `${writeError.message}; provider result remained unverified: ${verificationMessage}`
          : verificationMessage);
      }

      await this.completeTarget(lease, {
        actorId,
        appShopId,
        attempt: attempt ?? 1,
        triggerSource,
        preflightAlreadyDesired: false,
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

  private async setStoreStatus(authToken: string, bizStatus: 1 | 2) {
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

  private async verifyStoreStatus(
    authToken: string,
    desiredStatus: 1 | 2,
    totalTimeoutMs = READ_TIMEOUT_MS,
  ): Promise<void> {
    let observedStatus: number | null = null;
    let lastError: Error | null = null;
    const delayBudget = VERIFY_DELAY_MS * (VERIFY_ATTEMPTS - 1);
    const perAttemptTimeout = Math.max(
      1_000,
      Math.floor((totalTimeoutMs - delayBudget) / VERIFY_ATTEMPTS),
    );
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY_MS));
      try {
        observedStatus = await this.readStoreStatus(authToken, perAttemptTimeout);
        if (observedStatus === desiredStatus) return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (lastError && observedStatus === null) throw lastError;
    throw new Error(
      `POST /v1/shop/shop/setStatus was not verified: expected biz_status=${desiredStatus}, observed ${observedStatus ?? 'unknown'}`,
    );
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
