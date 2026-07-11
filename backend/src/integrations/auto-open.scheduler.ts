import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AutoOpenScheduler {
  private readonly logger = new Logger(AutoOpenScheduler.name);

  constructor(
    private prisma: PrismaService,
    @InjectQueue('auto-open') private queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async triggerScheduledPools() {
    const hour = new Date().getUTCHours();

    const pools = await this.prisma.autoOpenPool.findMany({
      where: { active: true, executionHours: { has: hour } },
    });

    for (const pool of pools) {
      try {
        const execution = await this.prisma.autoOpenExecution.create({
          data: { poolId: pool.id, status: 'pending' },
        });
        await this.queue.add('run-pool', { executionId: execution.id }, { jobId: execution.id });
        this.logger.log(`Queued pool "${pool.name}" (${pool.country}) at UTC hour ${hour}`);
      } catch (err) {
        this.logger.error(`Failed to queue pool ${pool.id}: ${(err as Error).message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldExecutions() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const { count } = await this.prisma.autoOpenExecution.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Cleaned up ${count} executions older than 7 days`);
  }
}
