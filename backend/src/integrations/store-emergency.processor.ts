import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
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

type EmergencyAction = 'offline' | 'restore';

@Injectable()
@Processor('store-emergency', { concurrency: 3 })
export class StoreEmergencyProcessor extends WorkerHost {
  private readonly logger = new Logger(StoreEmergencyProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) { super(); }

  async process(job: Job<StoreEmergencyJobData>) {
    const { emergencyId, action } = job.data;
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
      select: { status: true, startedAt: true, restoreStartedAt: true },
    });
    if (!snapshot) return;

    if (action === 'offline') {
      const claimed = await this.prisma.storeEmergency.updateMany({
        where: { id: emergencyId, status: 'pending' },
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
      if (snapshot.status !== 'restoring') {
        await this.recordSkippedJob(emergencyId, action, snapshot.status, job);
        return;
      }
      if (!snapshot.restoreStartedAt) {
        await this.prisma.storeEmergency.updateMany({
          where: { id: emergencyId, status: 'restoring', restoreStartedAt: null },
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

    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      include: {
        brand: { include: { application: { select: { appId: true, appSecret: true } } } },
        targets: {
          select: {
            id: true,
            offlineStatus: true,
            restoreStatus: true,
            shop: { select: { appShopId: true } },
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
      : target.offlineStatus === 'done' && target.restoreStatus === 'pending');
    let cursor = 0;
    const workers = Math.min(3, Math.max(1, targets.length));
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) return;
        const target = targets[index];
        await this.processTarget(
          emergency.id,
          target.id,
          target.shop.appShopId,
          application.appId,
          appSecret,
          action,
          actorId,
          triggerSource,
        );
      }
    };
    await Promise.all(Array.from({ length: workers }, () => worker()));
    await this.finalize(emergency.id, action, job, actionAttempt);
  }

  private async processTarget(
    emergencyId: string,
    targetId: string,
    appShopId: string,
    appId: string,
    appSecret: string,
    action: EmergencyAction,
    actorId: string | null,
    triggerSource: string,
  ) {
    const statusField = action === 'offline' ? 'offlineStatus' : 'restoreStatus';
    const errorField = action === 'offline' ? 'offlineError' : 'restoreError';
    const dateField = action === 'offline' ? 'offlineAt' : 'restoredAt';
    const attemptsField = action === 'offline' ? 'offlineAttempts' : 'restoreAttempts';
    const phase = action === 'offline' ? 'shutdown' : 'restore';
    const startedAt = new Date();
    const claimed = await this.prisma.storeEmergencyTarget.updateMany({
      where: { id: targetId, [statusField]: 'pending' },
      data: {
        [statusField]: 'running',
        [errorField]: null,
        [attemptsField]: { increment: 1 },
      },
    });
    if (claimed.count === 0) return;
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
      const authToken = await getAuthToken(appId, appSecret, appShopId);
      await this.setStoreStatus(authToken, action === 'offline' ? 2 : 1);
      const completedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.storeEmergencyTarget.update({
          where: { id: targetId },
          data: { [statusField]: 'done', [dateField]: completedAt },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId,
            targetId,
            type: action === 'offline' ? 'target_shutdown_succeeded' : 'target_restore_succeeded',
            phase,
            outcome: 'succeeded',
            source: 'worker',
            actorId,
            attempt: attempt ?? 1,
            message: `${action === 'offline' ? 'Shutdown' : 'Reopening'} completed for store ${appShopId}`,
            metadata: { triggerSource },
            occurredAt: completedAt,
          }),
        }),
      ]);
    } catch (error) {
      const message = sanitizeEmergencyMessage((error as Error).message);
      const failedAt = new Date();
      this.logger.error(`${action} failed for app_shop_id ${appShopId}: ${message}`);
      await this.prisma.$transaction([
        this.prisma.storeEmergencyTarget.update({
          where: { id: targetId },
          data: { [statusField]: 'failed', [errorField]: message },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId,
            targetId,
            type: action === 'offline' ? 'target_shutdown_failed' : 'target_restore_failed',
            phase,
            outcome: 'failed',
            source: 'worker',
            actorId,
            attempt: attempt ?? 1,
            message,
            metadata: { triggerSource, appShopId },
            occurredAt: failedAt,
          }),
        }),
      ]);
    }
  }

  private async setStoreStatus(authToken: string, bizStatus: 1 | 2) {
    const endpoint = 'POST /v1/shop/shop/setStatus';
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, biz_status: bizStatus, auto_switch: 1 }),
    });
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
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
      .filter(row => row.offlineStatus === 'done' && ['pending', 'running'].includes(row.restoreStatus))
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
      const failed = total - succeeded;
      const status = succeeded === total ? 'offline' : succeeded > 0 ? 'partial_success' : 'failed';
      const message = failed > 0 ? `${failed} of ${total} store(s) could not be turned off` : null;
      await this.prisma.$transaction(async tx => {
        const finalized = await tx.storeEmergency.updateMany({
          where: { id: emergencyId, status: 'running' },
          data: {
            status,
            shutdownFinishedAt: now,
            ...(succeeded > 0 && !emergency.offlineAt ? { offlineAt: now } : {}),
            finishedAt: succeeded === 0 ? now : null,
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
            metadata: { total, succeeded, failed, retry: job.data.retry === true },
            occurredAt: now,
          }),
        });
      });
      return;
    }

    const offlineSucceeded = grouped
      .filter(row => row.offlineStatus === 'done')
      .reduce((sum, row) => sum + row._count._all, 0);
    const restored = grouped
      .filter(row => row.offlineStatus === 'done' && row.restoreStatus === 'done')
      .reduce((sum, row) => sum + row._count._all, 0);
    const restoreFailed = grouped
      .filter(row => row.offlineStatus === 'done' && row.restoreStatus === 'failed')
      .reduce((sum, row) => sum + row._count._all, 0);
    const status = restored === offlineSucceeded ? 'restored' : restored > 0 ? 'partial_restored' : 'restore_failed';
    const message = restoreFailed > 0 || offlineSucceeded < total
      ? `${restored}/${offlineSucceeded} offline store(s) restored; ${restoreFailed} restore failure(s); ${total - offlineSucceeded} store(s) were never turned off`
      : null;
    await this.prisma.$transaction(async tx => {
      const finalized = await tx.storeEmergency.updateMany({
        where: { id: emergencyId, status: 'restoring' },
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
          message: message ?? `All ${restored} offline store(s) were reopened`,
          metadata: {
            total,
            offlineSucceeded,
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
            : { offlineStatus: 'done', restoreStatus: { in: ['pending', 'running'] } },
          select: { id: true, offlineAttempts: true, restoreAttempts: true },
        },
      },
    });
    if (!emergency) return;
    const actorId = job?.data.actorId ?? null;
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.storeEmergency.updateMany({
        where: action === 'offline'
          ? { id: emergencyId, status: { in: ['pending', 'running'] } }
          : { id: emergencyId, status: 'restoring' },
        data: { errorMessage: message },
      });
      if (claimed.count === 0) return;
      await tx.storeEmergencyTarget.updateMany({
        where: action === 'offline'
          ? { emergencyId, offlineStatus: { in: ['pending', 'running'] } }
          : { emergencyId, offlineStatus: 'done', restoreStatus: { in: ['pending', 'running'] } },
        data: action === 'offline'
          ? { offlineStatus: 'failed', offlineError: message }
          : { restoreStatus: 'failed', restoreError: message },
      });
      const failedTargets = await tx.storeEmergencyTarget.findMany({
        where: action === 'offline'
          ? {
              id: { in: emergency.targets.map(target => target.id) },
              offlineStatus: 'failed',
              offlineError: message,
            }
          : {
              id: { in: emergency.targets.map(target => target.id) },
              offlineStatus: 'done',
              restoreStatus: 'failed',
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
      const restored = grouped
        .filter(row => row.offlineStatus === 'done' && row.restoreStatus === 'done')
        .reduce((sum, row) => sum + row._count._all, 0);
      const derivedStatus = action === 'offline'
        ? shutdownSucceeded === total && total > 0
          ? 'offline'
          : shutdownSucceeded > 0 ? 'partial_success' : 'failed'
        : shutdownSucceeded > 0 && restored === shutdownSucceeded
          ? 'restored'
          : restored > 0 ? 'partial_restored' : 'restore_failed';
      const outcome = derivedStatus === 'offline' || derivedStatus === 'restored'
        ? 'succeeded'
        : derivedStatus === 'partial_success' || derivedStatus === 'partial_restored'
          ? 'partial'
          : 'failed';
      await tx.storeEmergency.updateMany({
        where: action === 'offline'
          ? { id: emergencyId, status: { in: ['pending', 'running'] } }
          : { id: emergencyId, status: 'restoring' },
        data: {
          status: derivedStatus,
          errorMessage: message,
          ...(action === 'offline' ? { shutdownFinishedAt: failedAt } : { restoreFinishedAt: failedAt }),
          ...(action === 'offline' && shutdownSucceeded > 0 && !emergency.offlineAt ? { offlineAt: failedAt } : {}),
          ...(action === 'restore' && restored > 0 && !emergency.restoredAt ? { restoredAt: failedAt } : {}),
          finishedAt: action === 'offline' && shutdownSucceeded > 0 ? null : failedAt,
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
    if (job) {
      await this.failEmergency(
        job.data.emergencyId,
        job.data.action,
        error.message,
        job,
        job.attemptsMade + 1,
      );
    }
  }
}
