import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutoOpenPoolsService } from './auto-open-pools.service';

export function hourInTimezone(date: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).find(part => part.type === 'hour')?.value;
  return Number(hour);
}

@Injectable()
export class AutoOpenScheduler {
  private readonly logger = new Logger(AutoOpenScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly poolsService: AutoOpenPoolsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async triggerScheduledPools() {
    await this.poolsService.ensureManagedKaPools();
    const now = new Date();
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    const pools = await this.prisma.autoOpenPool.findMany({ where: { active: true } });

    for (const pool of pools) {
      try {
        const localHour = hourInTimezone(slot, pool.timezone);
        if (!pool.executionHours.includes(localHour)) continue;
        const execution = await this.poolsService.runScheduled(pool.id, slot);
        if (execution) this.logger.log(`Queued pool "${pool.name}" at ${localHour}:00 ${pool.timezone}`);
      } catch (error) {
        this.logger.error(`Failed to queue Auto Open pool ${pool.id}: ${(error as Error).message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldExecutions() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const { count } = await this.prisma.autoOpenExecution.deleteMany({
      where: { createdAt: { lt: cutoff }, status: { notIn: ['pending', 'running'] } },
    });
    if (count > 0) this.logger.log(`Cleaned up ${count} Auto Open executions older than 30 days`);
  }
}
