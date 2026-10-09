import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SftpApiService } from './sftp-api.service';
import { nextSchedule, Schedule } from './sftp-api.util';

@Injectable()
export class SftpApiScheduler {
  private readonly logger = new Logger(SftpApiScheduler.name);
  private busy = false;
  constructor(private readonly prisma: PrismaService, private readonly service: SftpApiService) {}
  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await this.prisma.sftpApiRun.findMany({ where: { status: { in: ['pending', 'running'] } }, select: { id: true } });
      for (const row of pending) await this.service.enqueue(row.id).catch(() => this.logger.warn(`No se pudo reconciliar ${row.id}`));
      const rules = await this.prisma.sftpApiRule.findMany({ where: { active: true, nextRunAt: { lte: new Date() }, brand: { deletedAt: null } } });
      for (const rule of rules) {
        const mode = nextSchedule(rule.schedules as Schedule[], new Date(rule.nextRunAt!.getTime() - 60_000)).mode;
        await this.service.run(rule.id, mode, undefined, rule.nextRunAt!).catch(() => this.logger.warn(`Ejecución pendiente para ${rule.id}`));
      }
    } finally { this.busy = false; }
  }
}
