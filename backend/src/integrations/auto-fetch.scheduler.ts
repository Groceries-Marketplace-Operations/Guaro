import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { nextDailyRun } from './auto-fetch-time.util';

@Injectable()
export class AutoFetchScheduler {
  private readonly logger = new Logger(AutoFetchScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('auto-fetch') private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDuePools() {
    const now = new Date();
    const pools = await this.prisma.autoFetchPool.findMany({
      where: { active: true, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const pool of pools) {
      const nextRunAt = nextDailyRun(now, pool.executionHour, pool.executionMinute, pool.timezone);
      const claimed = await this.prisma.autoFetchPool.updateMany({
        where: { id: pool.id, active: true, nextRunAt: { lte: now } },
        data: { nextRunAt, lastRunAt: now },
      });
      if (claimed.count === 0) continue;
      const existing = await this.prisma.autoFetchExecution.findFirst({
        where: { poolId: pool.id, status: { in: ['pending', 'running'] } },
      });
      if (existing) continue;
      const execution = await this.prisma.autoFetchExecution.create({ data: { poolId: pool.id } });
      await this.queue.add(`fetch-${pool.kind}`, { executionId: execution.id }, {
        jobId: execution.id,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
      this.logger.log(`Queued ${pool.kind} catalog fetch for ${pool.country}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanup() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await this.prisma.autoFetchExecution.deleteMany({ where: { createdAt: { lt: cutoff } } });
  }
}
