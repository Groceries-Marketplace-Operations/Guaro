import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutoTurnOffService } from './auto-turn-off.service';
import { timezoneForCountry } from './auto-fetch-time.util';
import { nextAutoTurnOffOccurrence } from './auto-turn-off-time.util';

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
    const expired = await this.prisma.autoTurnOffRule.updateMany({
      where: { active: true, endsAt: { lte: now } },
      data: { active: false, configVersion: { increment: 1 } },
    });
    if (expired.count > 0) this.logger.log(`Automatically stopped ${expired.count} expired auto turn off rule(s)`);

    const dueRules = await this.prisma.autoTurnOffRule.findMany({
      where: {
        active: true,
        nextRunAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        pool: { active: true },
        executions: { none: { status: { in: ['pending', 'running'] } } },
      },
      select: {
        id: true,
        poolId: true,
        name: true,
        startsAt: true,
        intervalMinutes: true,
        scheduleMode: true,
        executionTimes: true,
        pool: { select: { country: true } },
      },
      orderBy: { nextRunAt: 'asc' },
    });

    for (const rule of dueRules) {
      try {
        const nextRunAt = nextAutoTurnOffOccurrence({
          ...rule,
          timezone: timezoneForCountry(rule.pool.country),
          after: new Date(now.getTime() + 1),
        });
        const claimed = await this.prisma.autoTurnOffRule.updateMany({
          where: {
            id: rule.id,
            active: true,
            nextRunAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
            pool: { active: true },
            executions: { none: { status: { in: ['pending', 'running'] } } },
          },
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

  @Cron('*/5 * * * *')
  async recoverInterruptedExecutions() {
    const recovered = await this.service.recoverStaleExecutions(15);
    if (recovered > 0) {
      this.logger.warn(`Recovered ${recovered} interrupted auto turn off execution(s)`);
    }
  }

  @Cron('0 */10 * * * *')
  async cleanupOldExecutions() {
    const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const expired = await this.prisma.autoTurnOffExecution.findMany({
      where: {
        createdAt: { lt: cutoff },
        status: { notIn: ['pending', 'running'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (expired.length === 0) return;
    const { count } = await this.prisma.autoTurnOffExecution.deleteMany({
      where: {
        id: { in: expired.map(execution => execution.id) },
        createdAt: { lt: cutoff },
        status: { notIn: ['pending', 'running'] },
      },
    });
    if (count > 0) this.logger.log(`Cleaned up ${count} auto turn off executions older than 2 days`);
  }
}
