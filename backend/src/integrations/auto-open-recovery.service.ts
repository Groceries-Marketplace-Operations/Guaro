import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutoOpenStatus } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AutoOpenProcessor } from './auto-open.processor';

const STALE_AFTER_MS = 10 * 60_000;
const ACTIVE_QUEUE_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

@Injectable()
export class AutoOpenRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(AutoOpenRecoveryService.name);
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: AutoOpenProcessor,
    @InjectQueue('auto-open') private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    await this.reconcile('startup');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recoverStaleExecutions() {
    await this.reconcile('periodic');
  }

  private async reconcile(reason: 'startup' | 'periodic') {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const executions = await this.prisma.autoOpenExecution.findMany({
        where: { status: { in: [AutoOpenStatus.pending, AutoOpenStatus.running] } },
        include: { brandRuns: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      });
      const cutoff = new Date(Date.now() - STALE_AFTER_MS);

      for (const execution of executions) {
        if (execution.status === AutoOpenStatus.pending) {
          await this.ensureJob(
            'prepare-pool',
            { executionId: execution.id },
            `auto-open-prepare-${execution.id}`,
          );
          continue;
        }

        if (!execution.brandRuns.length) {
          const rootJob = await this.queue.getJob(`auto-open-prepare-${execution.id}`);
          const rootState = rootJob ? await rootJob.getState() : 'missing';
          const stale = reason === 'startup'
            || (!ACTIVE_QUEUE_STATES.has(rootState)
              && (execution.heartbeatAt ?? execution.startedAt ?? execution.createdAt) < cutoff);
          if (stale) {
            const message = reason === 'startup'
              ? 'Interrupted by service restart before brand checkpoints were created'
              : 'Auto Open execution lost its queue job before brand checkpoints were created';
            await this.prisma.autoOpenExecution.updateMany({
              where: { id: execution.id, status: AutoOpenStatus.running },
              data: {
                status: AutoOpenStatus.failed,
                finishedAt: new Date(),
                heartbeatAt: new Date(),
                errorMessage: message,
                logs: { error: message, recovery: reason },
              },
            });
            this.logger.warn(`Closed orphan Auto Open execution ${execution.id}: ${message}`);
          }
          continue;
        }

        for (const run of execution.brandRuns) {
          if (run.status === AutoOpenStatus.running) {
            const jobId = `auto-open-brand-${run.id}`;
            const existing = await this.queue.getJob(jobId);
            const state = existing ? await existing.getState() : 'missing';
            const stale = reason === 'startup' || (!ACTIVE_QUEUE_STATES.has(state) && run.updatedAt < cutoff);
            if (stale) {
              await this.prisma.autoOpenBrandExecution.updateMany({
                where: { id: run.id, status: AutoOpenStatus.running },
                data: {
                  status: AutoOpenStatus.pending,
                  errorMessage: `Recovered after ${reason === 'startup' ? 'service restart' : 'lost queue job'}`,
                },
              });
            }
          }
        }

        const pendingRuns = await this.prisma.autoOpenBrandExecution.findMany({
          where: { executionId: execution.id, status: AutoOpenStatus.pending },
          select: { id: true },
        });
        for (const run of pendingRuns) {
          await this.ensureJob(
            'run-brand',
            { executionId: execution.id, brandRunId: run.id },
            `auto-open-brand-${run.id}`,
          );
        }
        await this.processor.reconcileExecution(execution.id);
      }
    } catch (error) {
      this.logger.error(`Auto Open ${reason} reconciliation failed: ${(error as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async ensureJob(name: string, data: Record<string, string>, jobId: string) {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (ACTIVE_QUEUE_STATES.has(state)) return;
      await this.removeTerminalJob(existing);
    }
    await this.queue.add(name, data, {
      jobId,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 500,
    });
  }

  private async removeTerminalJob(job: Job) {
    try {
      await job.remove();
    } catch (error) {
      this.logger.warn(`Could not remove terminal Auto Open job ${job.id}: ${(error as Error).message}`);
    }
  }
}
