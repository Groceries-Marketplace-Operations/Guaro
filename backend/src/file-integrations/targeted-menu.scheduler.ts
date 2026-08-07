import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TargetedMenuService } from './targeted-menu.service';

function nextDaily(value: Date, now: Date) {
  const next = new Date(value);
  do next.setUTCDate(next.getUTCDate() + 1); while (next <= now);
  return next;
}

@Injectable()
export class TargetedMenuScheduler implements OnModuleInit {
  private readonly logger = new Logger(TargetedMenuScheduler.name);

  constructor(private readonly prisma: PrismaService, private readonly service: TargetedMenuService) {}

  async onModuleInit() {
    const interrupted = await this.prisma.targetedMenuExecution.findMany({
      where: { status: { in: ['pending', 'running'] } }, select: { id: true, ruleId: true, cancelRequested: true },
    });
    if (!interrupted.length) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.targetedMenuExecution.updateMany({
        where: { id: { in: interrupted.map(value => value.id) } },
        data: {
          status: 'cancelled',
          finishedAt: now,
          currentShopId: null,
          errorMessage: 'Interrupted by service restart',
        },
      }),
      this.prisma.targetedMenuRule.updateMany({
        where: {
          id: { in: [...new Set(interrupted.filter(value => !value.cancelRequested).map(value => value.ruleId))] },
          active: true,
          deletedAt: null,
        },
        data: { nextRunAt: now },
      }),
    ]);
    this.logger.warn(`Recovered ${interrupted.length} interrupted targeted menu execution(s)`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    const now = new Date();
    const rules = await this.prisma.targetedMenuRule.findMany({
      where: { active: true, deletedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const rule of rules) {
      const nextRunAt = nextDaily(rule.nextRunAt ?? rule.startsAt, now);
      const claimed = await this.prisma.targetedMenuRule.updateMany({
        where: { id: rule.id, active: true, nextRunAt: { lte: now } }, data: { nextRunAt },
      });
      if (!claimed.count) continue;
      const activeExecution = await this.prisma.targetedMenuExecution.count({
        where: { ruleId: rule.id, status: { in: ['pending', 'running'] } },
      });
      if (activeExecution) continue;
      await this.service.run(rule.id, undefined, 'scheduled');
      this.logger.log(`Queued daily targeted menu rule ${rule.name}`);
    }
  }
}
