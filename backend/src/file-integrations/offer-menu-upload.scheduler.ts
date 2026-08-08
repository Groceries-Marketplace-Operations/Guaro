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
      select: { id: true, ruleId: true, cancelRequested: true, result: true },
    });
    if (!interrupted.length) return;
    const resumable = interrupted.filter(value => {
      if (value.cancelRequested || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) return false;
      const result = value.result as Record<string, unknown>;
      return result.phase === 'checking_status'
        && Array.isArray(result.submittedTasks)
        && result.submittedTasks.length > 0;
    });
    if (resumable.length) {
      await this.prisma.offerMenuUploadExecution.updateMany({
        where: { id: { in: resumable.map(value => value.id) } },
        data: { status: 'pending', currentStoreId: null, errorMessage: null },
      });
      for (const execution of resumable) await this.service.resumeExecution(execution.id);
      this.logger.warn(`Resumed status monitoring for ${resumable.length} interrupted offer menu execution(s)`);
    }
    const resumableIds = new Set(resumable.map(value => value.id));
    const cancelled = interrupted.filter(value => !resumableIds.has(value.id));
    if (!cancelled.length) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.offerMenuUploadExecution.updateMany({
        where: { id: { in: cancelled.map(value => value.id) } },
        data: {
          status: 'cancelled',
          finishedAt: now,
          currentStoreId: null,
          errorMessage: 'Interrupted by service restart',
        },
      }),
      this.prisma.offerMenuUploadRule.updateMany({
        where: {
          id: { in: [...new Set(cancelled.filter(value => !value.cancelRequested).map(value => value.ruleId))] },
          active: true,
          deletedAt: null,
        },
        data: { nextRunAt: now },
      }),
    ]);
    this.logger.warn(`Recovered ${cancelled.length} interrupted offer menu execution(s) by scheduling a new run`);
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
