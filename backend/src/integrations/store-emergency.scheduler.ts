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

@Injectable()
export class StoreEmergencyScheduler {
  private readonly logger = new Logger(StoreEmergencyScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('store-emergency') private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async restoreExpiredEmergencies() {
    const now = new Date();
    const due = await this.prisma.storeEmergency.findMany({
      where: { status: { in: ['offline', 'partial_success'] }, endsAt: { lte: now } },
      select: {
        id: true,
        status: true,
        endsAt: true,
        restoreRequestedAt: true,
        restoreQueuedAt: true,
      },
      orderBy: { endsAt: 'asc' },
    });
    for (const emergency of due) {
      const requestedAt = new Date();
      const claimed = await this.prisma.$transaction(async tx => {
        const updated = await tx.storeEmergency.updateMany({
          where: { id: emergency.id, status: { in: ['offline', 'partial_success'] }, endsAt: { lte: now } },
          data: {
            status: 'restoring',
            errorMessage: null,
            ...(!emergency.restoreRequestedAt ? { restoreRequestedAt: requestedAt } : {}),
          },
        });
        if (updated.count === 0) return false;
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
        return true;
      });
      if (!claimed) continue;

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
        const targets = await this.prisma.storeEmergencyTarget.findMany({
          where: {
            emergencyId: emergency.id,
            offlineStatus: 'done',
            restoreStatus: { in: ['pending', 'running'] },
          },
          select: { id: true, restoreAttempts: true },
        });
        await this.prisma.$transaction(async tx => {
          await tx.storeEmergency.update({
            where: { id: emergency.id },
            data: {
              status: 'restore_failed',
              errorMessage: message,
              restoreFinishedAt: failedAt,
              finishedAt: failedAt,
            },
          });
          await tx.storeEmergencyTarget.updateMany({
            where: {
              emergencyId: emergency.id,
              offlineStatus: 'done',
              restoreStatus: { in: ['pending', 'running'] },
            },
            data: { restoreStatus: 'failed', restoreError: message },
          });
          for (let index = 0; index < targets.length; index += 500) {
            const targetBatch = targets.slice(index, index + 500);
            await tx.storeEmergencyEvent.createMany({
              data: targetBatch.map(target => emergencyEventData({
                emergencyId: emergency.id,
                targetId: target.id,
                type: 'target_restore_failed',
                phase: 'restore',
                outcome: 'failed',
                source: 'scheduler',
                attempt: target.restoreAttempts || null,
                message,
                metadata: { globalFailure: true, trigger: 'schedule' },
                occurredAt: failedAt,
              })),
            });
          }
          await tx.storeEmergencyEvent.create({
            data: emergencyEventData({
              emergencyId: emergency.id,
              type: 'queue_failed',
              phase: 'system',
              outcome: 'failed',
              source: 'scheduler',
              message,
              metadata: { action: 'restore', trigger: 'schedule', affectedTargets: targets.length },
              occurredAt: failedAt,
            }),
          });
        }, { timeout: 30_000 });
        continue;
      }

      const queuedAt = new Date(queuedJob.timestamp);
      try {
        await this.prisma.$transaction([
          this.prisma.storeEmergency.update({
            where: { id: emergency.id },
            data: { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
          }),
          this.prisma.storeEmergencyEvent.create({
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
          }),
        ]);
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
        updatedAt: { lte: staleBefore },
        status: { in: ['pending', 'restoring'] },
      },
      select: {
        id: true,
        status: true,
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
      const recovered = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(CAST(${emergency.id} AS text), 0))
        `);
        const current = await tx.storeEmergency.findUnique({
          where: { id: emergency.id },
          select: { status: true },
        });
        if (!current || !['pending', 'restoring'].includes(current.status)) return false;
        const currentAction = current.status === 'restoring' ? 'restore' : 'offline';
        if (currentAction !== action) return false;
        const recentRecovery = await tx.storeEmergencyEvent.findFirst({
          where: { emergencyId: emergency.id, type: 'recovery_queued', occurredAt: { gt: staleBefore } },
          select: { id: true },
        });
        if (recentRecovery) return false;
        const runningTarget = await tx.storeEmergencyTarget.findFirst({
          where: action === 'offline'
            ? { emergencyId: emergency.id, offlineStatus: 'running' }
            : { emergencyId: emergency.id, restoreStatus: 'running' },
          select: { id: true },
        });
        // A remote DiDi request may still be in flight. Without an idempotency key
        // or a lease heartbeat, resetting a running target could duplicate the POST.
        if (runningTarget) return false;

        const transition = await tx.storeEmergency.updateMany({
          where: { id: emergency.id, status: current.status },
          data: { status: action === 'offline' ? 'pending' : 'restoring' },
        });
        if (transition.count === 0) return false;
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: emergency.id,
            type: 'stale_transition_recovered',
            phase: 'system',
            outcome: 'requested',
            source: 'system',
            message: `Recovered stale ${action} queue transition before re-enqueueing`,
            metadata: { action, previousStatus: current.status, staleMinutes: 5 },
          }),
        });
        return true;
      }, { maxWait: 10_000, timeout: 30_000 });
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
        await this.prisma.$transaction([
          this.prisma.storeEmergency.update({
            where: { id: emergency.id },
            data: action === 'offline'
              ? { ...(!emergency.shutdownQueuedAt ? { shutdownQueuedAt: queuedAt } : {}) }
              : { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
          }),
          this.prisma.storeEmergencyEvent.create({
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
          }),
        ]);
      } catch (error) {
        this.logger.error(`Recovery job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
      }
    }
  }
}
