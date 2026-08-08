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
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true, ruleId: true, cancelRequested: true, rule: { select: { name: true } } },
    });
    if (!interrupted.length) return;
    const now = new Date();
    const cancelled = interrupted.filter(value => value.cancelRequested);
    const resumable = interrupted.filter(value => !value.cancelRequested);
    if (cancelled.length) await this.prisma.targetedMenuExecution.updateMany({
      where: { id: { in: cancelled.map(value => value.id) } },
      data: {
        status: 'cancelled',
        finishedAt: now,
        currentShopId: null,
        errorMessage: 'Stopped before service restart',
      },
    });
    if (resumable.length) await this.prisma.$transaction([
      this.prisma.targetedMenuExecution.updateMany({
        where: { id: { in: resumable.map(value => value.id) } },
        data: {
          status: 'pending',
          finishedAt: null,
          errorMessage: 'Resuming after service restart',
        },
      }),
    ]);
    for (const execution of resumable) {
      await this.service.resume(execution.id, execution.rule.name);
    }
    this.logger.warn(
      `Resumed ${resumable.length} interrupted targeted menu execution(s); cancelled ${cancelled.length}`,
    );
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
