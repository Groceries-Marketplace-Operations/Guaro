import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OfferMenuUploadService } from './offer-menu-upload.service';
import { nextOfferMenuRun } from './offer-menu-upload.util';

@Injectable()
export class OfferMenuUploadScheduler implements OnModuleInit {
  private readonly logger = new Logger(OfferMenuUploadScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: OfferMenuUploadService,
  ) {}

  async onModuleInit() {
    const interrupted = await this.prisma.offerMenuUploadExecution.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true, ruleId: true, cancelRequested: true },
    });
    if (!interrupted.length) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.offerMenuUploadExecution.updateMany({
        where: { id: { in: interrupted.map(value => value.id) } },
        data: {
          status: 'cancelled',
          finishedAt: now,
          currentStoreId: null,
          errorMessage: 'Interrupted by service restart',
        },
      }),
      this.prisma.offerMenuUploadRule.updateMany({
        where: {
          id: { in: [...new Set(interrupted.filter(value => !value.cancelRequested).map(value => value.ruleId))] },
          active: true,
          deletedAt: null,
        },
        data: { nextRunAt: now },
      }),
    ]);
    this.logger.warn(`Recovered ${interrupted.length} interrupted offer menu execution(s)`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    const now = new Date();
    const rules = await this.prisma.offerMenuUploadRule.findMany({
      where: { active: true, deletedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const rule of rules) {
      const nextRunAt = nextOfferMenuRun(rule.scheduleHours as number[], rule.timezone, now);
      const claimed = await this.prisma.offerMenuUploadRule.updateMany({
        where: { id: rule.id, active: true, deletedAt: null, nextRunAt: { lte: now } },
        data: { nextRunAt },
      });
      if (!claimed.count) continue;
      const activeExecution = await this.prisma.offerMenuUploadExecution.count({
        where: { ruleId: rule.id, status: { in: ['pending', 'running'] } },
      });
      if (activeExecution) continue;
      await this.service.run(rule.id, undefined, 'scheduled', false);
      this.logger.log(`Queued scheduled offer menu rule ${rule.name}`);
    }
  }
}
