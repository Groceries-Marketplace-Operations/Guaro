import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutoTurnOffService } from './auto-turn-off.service';

@Injectable()
export class AutoTurnOffScheduler {
  private readonly logger = new Logger(AutoTurnOffScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: AutoTurnOffService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async triggerDueRules() {
    const now = new Date();
    const dueRules = await this.prisma.autoTurnOffRule.findMany({
      where: { active: true, nextRunAt: { lte: now }, pool: { active: true } },
      select: { id: true, poolId: true, name: true, startsAt: true, intervalMinutes: true },
      orderBy: { nextRunAt: 'asc' },
    });

    for (const rule of dueRules) {
      try {
        const nextRunAt = this.nextOccurrence(rule.startsAt, rule.intervalMinutes, new Date(now.getTime() + 1));
        const claimed = await this.prisma.autoTurnOffRule.updateMany({
          where: { id: rule.id, active: true, nextRunAt: { lte: now }, pool: { active: true } },
          data: { nextRunAt, lastRunAt: now },
        });
        if (claimed.count === 0) continue;

        await this.service.enqueueExecution(rule.poolId, rule.id, 'scheduled');
        this.logger.log(`Queued auto turn off rule "${rule.name}"; next run ${nextRunAt.toISOString()}`);
      } catch (error) {
        this.logger.error(`Could not schedule rule ${rule.id}: ${(error as Error).message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldExecutions() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const { count } = await this.prisma.autoTurnOffExecution.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Cleaned up ${count} auto turn off executions older than 30 days`);
  }

  private nextOccurrence(startsAt: Date, intervalMinutes: number, after: Date) {
    if (startsAt.getTime() >= after.getTime()) return startsAt;
    const intervalMs = intervalMinutes * 60_000;
    const elapsed = after.getTime() - startsAt.getTime();
    return new Date(startsAt.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
  }
}
