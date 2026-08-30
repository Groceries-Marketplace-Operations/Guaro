import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { nextOfferMenuRun } from './offer-menu-upload.util';
import { UpcActivityPriceService } from './upc-activity-price.service';

@Injectable()
export class UpcActivityPriceScheduler implements OnModuleInit {
  private readonly logger = new Logger(UpcActivityPriceScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: UpcActivityPriceService,
  ) {}

  async onModuleInit() {
    const interrupted = await this.prisma.upcActivityPriceExecution.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true, ruleId: true, cancelRequested: true },
    });
    if (!interrupted.length) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.upcActivityPriceExecution.updateMany({
        where: { id: { in: interrupted.map(value => value.id) } },
        data: { status: 'cancelled', finishedAt: now, currentShopId: null, errorMessage: 'Interrupted by service restart' },
      }),
      this.prisma.upcActivityPriceRule.updateMany({
        where: {
          id: { in: [...new Set(interrupted.filter(value => !value.cancelRequested).map(value => value.ruleId))] },
          active: true,
          deletedAt: null,
        },
        data: { nextRunAt: now },
      }),
    ]);
    this.logger.warn(`Recovered ${interrupted.length} interrupted UPC activity-price execution(s)`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    const now = new Date();
    const rules = await this.prisma.upcActivityPriceRule.findMany({
      where: { active: true, deletedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const rule of rules) {
      const nextRunAt = nextOfferMenuRun(rule.scheduleHours as number[], rule.timezone, now);
      const claimed = await this.prisma.upcActivityPriceRule.updateMany({
        where: { id: rule.id, active: true, deletedAt: null, nextRunAt: { lte: now } },
        data: { nextRunAt },
      });
      if (!claimed.count) continue;
      const activeExecution = await this.prisma.upcActivityPriceExecution.count({
        where: { ruleId: rule.id, status: { in: ['pending', 'running'] } },
      });
      if (activeExecution) continue;
      try {
        await this.service.run(rule.id, undefined, 'scheduled');
        this.logger.log(`Queued scheduled UPC activity-price rule ${rule.name}`);
      } catch (error) {
        this.logger.error(`Could not queue UPC activity-price rule ${rule.name}: ${(error as Error).message}`);
      }
    }
  }
}
