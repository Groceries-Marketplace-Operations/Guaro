import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileIntegrationsService } from './file-integrations.service';

@Injectable()
export class FileIntegrationScheduler implements OnModuleInit {
  private readonly logger = new Logger(FileIntegrationScheduler.name);

  constructor(private readonly prisma: PrismaService, private readonly service: FileIntegrationsService) {}

  async onModuleInit() {
    await this.prisma.fileIntegrationExecution.updateMany({
      where: { status: { in: ['pending', 'running'] }, cancelRequested: true },
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        currentFile: null,
        errorMessage: 'Stopped manually',
      },
    });
    await this.prisma.fileIntegrationFileState.updateMany({
      where: { status: 'running' },
      data: { status: 'pending', processingAt: null, lastError: 'Recovered after service restart' },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDueRules() {
    const now = new Date();
    const rules = await this.prisma.fileIntegrationRule.findMany({
      where: { active: true, deletedAt: null, intervalMinutes: { not: null }, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
    });
    for (const rule of rules) {
      const interval = Math.max(rule.intervalMinutes ?? 5, 5);
      const nextRunAt = new Date(now.getTime() + interval * 60_000);
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
