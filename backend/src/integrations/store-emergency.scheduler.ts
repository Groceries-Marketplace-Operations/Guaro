import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  emergencyEventData,
  sanitizeEmergencyMessage,
  StoreEmergencyJobData,
} from './store-emergency-events';

class StoreEmergencyRecoveryClaimLostError extends Error {
  constructor() {
    super('Store emergency recovery claim changed concurrently');
    this.name = 'StoreEmergencyRecoveryClaimLostError';
  }
}

@Injectable()
export class StoreEmergencyScheduler {
  private readonly logger = new Logger(StoreEmergencyScheduler.name);
  private reconciliationRunning = false;
  private reconciliationCursorId: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('store-emergency') private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileOfflineEmergencies() {
    if (this.reconciliationRunning) return;
    this.reconciliationRunning = true;
    try {
      const now = new Date();
      const minuteBucket = Math.floor(now.getTime() / 60_000);
      const where: Prisma.StoreEmergencyWhereInput = {
        status: { in: ['offline', 'partial_success'] },
        finishedAt: null,
        endsAt: { gt: now },
      };
      // Fetch one look-ahead row so <=100 live emergencies are all inspected
      // every minute, while larger fleets advance by a stable unique cursor
      // without an unbounded queue/API burst or mutable OFFSET gaps.
      const page = await this.prisma.storeEmergency.findMany({
        where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 101,
        ...(this.reconciliationCursorId
          ? { cursor: { id: this.reconciliationCursorId }, skip: 1 }
          : {}),
      });
      const live = page.slice(0, 100);
      this.reconciliationCursorId = page.length > 100 ? live[live.length - 1].id : undefined;
      for (const emergency of live) {
        const data: StoreEmergencyJobData = {
          emergencyId: emergency.id,
          action: 'reconcile',
          source: 'scheduler',
        };
        try {
          await this.queue.add('reconcile-store-emergency', data, {
            // A stable id coalesces scheduler ticks while a reconciliation is
            // queued/running; removal makes it eligible again on the next tick.
            jobId: `${emergency.id}-reconcile`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          });
        } catch (error) {
          const message = sanitizeEmergencyMessage(
            `Could not enqueue emergency reconciliation: ${(error as Error).message}`,
          );
          this.logger.error(`Reconciliation queue failed for ${emergency.id}: ${message}`);
          try {
            await this.prisma.storeEmergencyEvent.create({
              data: emergencyEventData({
                emergencyId: emergency.id,
                type: 'reconcile_queue_failed',
                phase: 'system',
                outcome: 'failed',
                source: 'scheduler',
                message,
                metadata: { minuteBucket, retryableNextMinute: true },
              }),
            });
          } catch (auditError) {
            this.logger.error(
              `Could not audit reconciliation queue failure for ${emergency.id}: ${(auditError as Error).message}`,
            );
          }
        }
      }
    } finally {
      this.reconciliationRunning = false;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async restoreExpiredEmergencies() {
    const now = new Date();
    const due = await this.prisma.storeEmergency.findMany({
      where: { status: { in: ['offline', 'partial_success'] }, finishedAt: null, endsAt: { lte: now } },
      select: {
        id: true,
        brandId: true,
        status: true,
        updatedAt: true,
        endsAt: true,
        restoreRequestedAt: true,
        restoreQueuedAt: true,
      },
      orderBy: { endsAt: 'asc' },
    });
    for (const emergency of due) {
      const requestedAt = new Date();
      const transition = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(CAST(${emergency.brandId} AS text), 0))
        `);
        const updated = await tx.storeEmergency.updateMany({
          where: {
            id: emergency.id,
            status: emergency.status,
            updatedAt: emergency.updatedAt,
            finishedAt: null,
            endsAt: { lte: now },
          },
          data: {
            status: 'restoring',
            errorMessage: null,
            ...(!emergency.restoreRequestedAt ? { restoreRequestedAt: requestedAt } : {}),
          },
        });
        if (updated.count === 0) return null;
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: emergency.id,
            type: 'restore_requested',
            phase: 'restore',
            outcome: 'requested',
            source: 'scheduler',
            message: 'Automatic reopening requested because the scheduled time was reached',
            metadata: { trigger: 'schedule', scheduledReopeningAt: emergency.endsAt.toISOString() },
            occurredAt: requestedAt,
          }),
        });
        const current = await tx.storeEmergency.findUniqueOrThrow({
          where: { id: emergency.id },
          select: { updatedAt: true },
        });
        return { updatedAt: current.updatedAt };
      }, { maxWait: 10_000, timeout: 45_000 });
      if (!transition) continue;

      const jobData: StoreEmergencyJobData = {
        emergencyId: emergency.id,
        action: 'restore',
        source: 'scheduler',
      };
      let queuedJob: Awaited<ReturnType<Queue['add']>>;
      try {
        queuedJob = await this.queue.add('set-store-emergency-status', jobData, {
          jobId: `${emergency.id}-restore`,
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 500,
        });
      } catch (error) {
        const message = sanitizeEmergencyMessage(`Could not enqueue restore: ${(error as Error).message}`);
        const failedAt = new Date();
        await this.prisma.$transaction(async tx => {
          const rolledBack = await tx.storeEmergency.updateMany({
            where: {
              id: emergency.id,
              status: 'restoring',
              updatedAt: transition.updatedAt,
              finishedAt: null,
            },
            data: {
              status: emergency.status,
              errorMessage: message,
              restoreRequestedAt: emergency.restoreRequestedAt,
              restoreQueuedAt: emergency.restoreQueuedAt,
            },
          });
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: emergency.id,
              type: 'queue_failed',
              phase: 'system',
              outcome: 'failed',
              source: 'scheduler',
              message,
              metadata: {
                action: 'restore',
                trigger: 'schedule',
                rollbackApplied: rolledBack.count === 1,
                retryable: true,
              },
              occurredAt: failedAt,
            }),
          });
        }, { timeout: 30_000 });
        continue;
      }

      const queuedAt = new Date(queuedJob.timestamp);
      try {
        await this.prisma.$transaction(async tx => {
          const marked = await tx.storeEmergency.updateMany({
            where: { id: emergency.id, status: 'restoring', finishedAt: null },
            data: { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
          });
          if (marked.count === 0) return;
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: emergency.id,
              type: 'restore_queued',
              phase: 'restore',
              outcome: 'queued',
              source: 'scheduler',
              message: 'Automatic store reopening queued',
              metadata: { trigger: 'schedule', jobId: String(queuedJob.id ?? `${emergency.id}-restore`) },
              occurredAt: queuedAt,
            }),
          });
        });
      } catch (error) {
        this.logger.error(`Restore job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
      }
      this.logger.log(`Queued automatic restore for store emergency ${emergency.id}`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStaleTransitions() {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 5 * 60_000);
    const stale = await this.prisma.storeEmergency.findMany({
      where: {
        finishedAt: null,
        status: { in: ['pending', 'running', 'restoring'] },
        OR: [
          { updatedAt: { lte: staleBefore } },
          {
            targets: {
              some: {
                updatedAt: { lte: staleBefore },
                OR: [{ offlineStatus: 'running' }, { restoreStatus: 'running' }],
              },
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        shutdownQueuedAt: true,
        restoreQueuedAt: true,
        events: {
          where: { type: 'recovery_queued', occurredAt: { gt: staleBefore } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });

    for (const emergency of stale) {
      if (emergency.events.length > 0) continue;
      const action = emergency.status === 'restoring' ? 'restore' : 'offline';
      let recovered: { resetTargets: number } | null;
      try {
        recovered = await this.prisma.$transaction(async tx => {
          await tx.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(hashtextextended(CAST(${emergency.id} AS text), 0))
          `);
          const current = await tx.storeEmergency.findUnique({
            where: { id: emergency.id },
            select: { status: true, updatedAt: true, finishedAt: true },
          });
          if (!current || current.finishedAt || !['pending', 'running', 'restoring'].includes(current.status)) return null;
          const currentAction = current.status === 'restoring' ? 'restore' : 'offline';
          if (currentAction !== action) return null;
          const recentRecovery = await tx.storeEmergencyEvent.findFirst({
            where: { emergencyId: emergency.id, type: 'recovery_queued', occurredAt: { gt: staleBefore } },
            select: { id: true },
          });
          if (recentRecovery) return null;
          const parentStale = current.updatedAt <= staleBefore;
          const reset = await tx.storeEmergencyTarget.updateMany({
            where: action === 'offline'
              ? { emergencyId: emergency.id, offlineStatus: 'running', updatedAt: { lte: staleBefore } }
              : {
                emergencyId: emergency.id,
                restoreStatus: 'running',
                updatedAt: { lte: staleBefore },
              },
            data: action === 'offline'
              ? { offlineStatus: 'pending' }
              : { restoreStatus: 'required' },
          });
          if (!parentStale && reset.count === 0) return null;
          const recentRunning = await tx.storeEmergencyTarget.findFirst({
            where: action === 'offline'
              ? { emergencyId: emergency.id, offlineStatus: 'running', updatedAt: { gt: staleBefore } }
              : { emergencyId: emergency.id, restoreStatus: 'running', updatedAt: { gt: staleBefore } },
            select: { id: true },
          });
          if (recentRunning && reset.count === 0) return null;

          const transition = await tx.storeEmergency.updateMany({
            where: {
              id: emergency.id,
              status: current.status,
              updatedAt: current.updatedAt,
              finishedAt: null,
            },
            data: {
              status: action === 'offline' ? 'pending' : 'restoring',
              // Keep the transition immediately recoverable if Redis enqueue fails.
              updatedAt: current.updatedAt,
            },
          });
          // Throw instead of returning so the stale target resets roll back too.
          if (transition.count === 0) throw new StoreEmergencyRecoveryClaimLostError();
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: emergency.id,
              type: 'stale_transition_recovered',
              phase: 'system',
              outcome: 'requested',
              source: 'system',
              message: `Recovered stale ${action} queue transition before re-enqueueing`,
              metadata: { action, previousStatus: current.status, staleMinutes: 5, resetTargets: reset.count },
            }),
          });
          return { resetTargets: reset.count };
        }, { maxWait: 10_000, timeout: 30_000 });
      } catch (error) {
        if (error instanceof StoreEmergencyRecoveryClaimLostError) continue;
        throw error;
      }
      if (!recovered) continue;

      const bucket = Math.floor(now.getTime() / (5 * 60_000));
      const jobData: StoreEmergencyJobData = {
        emergencyId: emergency.id,
        action,
        source: 'system',
        retry: true,
      };
      let queuedJob: Awaited<ReturnType<Queue['add']>>;
      try {
        queuedJob = await this.queue.add('set-store-emergency-status', jobData, {
          jobId: `${emergency.id}-${action}-recovery-${bucket}`,
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 500,
        });
      } catch (error) {
        const message = sanitizeEmergencyMessage(`Could not enqueue stale emergency recovery: ${(error as Error).message}`);
        await this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: emergency.id,
            type: 'queue_failed',
            phase: 'system',
            outcome: 'failed',
            source: 'system',
            message,
            metadata: { action, recovery: true },
          }),
        });
        continue;
      }

      const queuedAt = new Date(queuedJob.timestamp);
      try {
        await this.prisma.$transaction(async tx => {
          const marked = await tx.storeEmergency.updateMany({
            where: {
              id: emergency.id,
              status: action === 'offline' ? 'pending' : 'restoring',
              finishedAt: null,
            },
            data: action === 'offline'
              ? { ...(!emergency.shutdownQueuedAt ? { shutdownQueuedAt: queuedAt } : {}) }
              : { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
          });
          if (marked.count === 0) return;
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: emergency.id,
              type: 'recovery_queued',
              phase: 'system',
              outcome: 'queued',
              source: 'system',
              message: `Recovered stale ${action} transition by re-enqueuing it`,
              metadata: { action, jobId: String(queuedJob.id ?? ''), staleMinutes: 5 },
              occurredAt: queuedAt,
            }),
          });
        });
      } catch (error) {
        this.logger.error(`Recovery job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
      }
    }
  }
}
