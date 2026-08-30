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
    await this.recoverActiveExecutions();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    // Also reconcile during normal operation so a transient Redis enqueue
    // failure does not require another application restart.
    await this.recoverActiveExecutions();
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

  private async recoverActiveExecutions() {
    const active = await this.prisma.upcActivityPriceExecution.findMany({
      where: {
        status: { in: ['pending', 'running'] },
        manualReviewRequired: false,
      },
      select: { id: true },
      take: 1000,
    });
    let recovered = 0;
    for (const execution of active) {
      try {
        if (await this.service.ensureExecutionQueued(execution.id) === 'queued') recovered += 1;
      } catch (error) {
        this.logger.error(
          `Could not reconcile UPC activity-price execution ${execution.id}: ${(error as Error).message}`,
        );
      }
    }
    if (recovered) {
      this.logger.warn(`Requeued ${recovered} existing UPC activity-price execution(s) for recovery`);
    }
  }
}
