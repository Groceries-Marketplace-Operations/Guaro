import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAILY_STATUS_ACTIVATION_TIME,
  DAILY_STATUS_ACTIVATION_TIMEZONE,
  nextDailyFileIntegrationRun,
} from './daily-status-activation.util';
import { FileIntegrationsService } from './file-integrations.service';

@Injectable()
export class FileIntegrationScheduler implements OnModuleInit {
  private readonly logger = new Logger(FileIntegrationScheduler.name);

  constructor(private readonly prisma: PrismaService, private readonly service: FileIntegrationsService) {}

  async onModuleInit() {
    const interrupted = await this.prisma.fileIntegrationExecution.findMany({
      where: { status: { in: ['pending', 'running'] }, cancelRequested: false },
      select: { id: true, ruleId: true },
    });
    await this.prisma.fileIntegrationExecution.updateMany({
      where: { status: { in: ['pending', 'running'] }, cancelRequested: true },
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        currentFile: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (interrupted.length > 0) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.fileIntegrationExecution.updateMany({
          where: { id: { in: interrupted.map(value => value.id) }, status: { in: ['pending', 'running'] } },
          data: {
            status: 'cancelled',
            finishedAt: now,
            currentFile: null,
            errorMessage: 'Interrupted by service restart; automatically rescheduled',
          },
        }),
        this.prisma.fileIntegrationRule.updateMany({
          where: {
            id: { in: [...new Set(interrupted.map(value => value.ruleId))] },
            active: true,
            deletedAt: null,
          },
          data: { nextRunAt: now },
        }),
      ]);
      this.logger.warn(`Recovered ${interrupted.length} interrupted file integration execution(s)`);
    }
    await this.prisma.fileIntegrationFileState.updateMany({
      where: { status: 'running' },
      data: { status: 'pending', processingAt: null, lastError: 'Recovered after service restart' },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    const now = new Date();
    const rules = await this.prisma.fileIntegrationRule.findMany({
      where: { active: true, deletedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const rule of rules) {
      const nextRunAt = rule.dailyTime
        ? nextDailyFileIntegrationRun(
            rule.dailyTime ?? DAILY_STATUS_ACTIVATION_TIME,
            rule.timezone || DAILY_STATUS_ACTIVATION_TIMEZONE,
            now,
          )
        : new Date(now.getTime() + Math.max(rule.intervalMinutes ?? 5, 5) * 60_000);
      const claimed = await this.prisma.fileIntegrationRule.updateMany({
        where: { id: rule.id, active: true, nextRunAt: { lte: now } }, data: { nextRunAt },
      });
      if (!claimed.count) continue;
      const existing = await this.prisma.fileIntegrationExecution.findFirst({
        where: { ruleId: rule.id, status: { in: ['pending', 'running'] } },
      });
      if (existing) continue;
      const execution = await this.prisma.fileIntegrationExecution.create({ data: { ruleId: rule.id, trigger: 'scheduled' } });
      await this.service.enqueue(execution.id, rule.name);
      this.logger.log(`Queued file integration ${rule.name}`);
    }
  }
}
