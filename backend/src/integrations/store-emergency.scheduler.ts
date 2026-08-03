import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoreEmergencyScheduler {
  private readonly logger = new Logger(StoreEmergencyScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('store-emergency') private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async restoreExpiredEmergencies() {
    const now = new Date();
    const due = await this.prisma.storeEmergency.findMany({
      where: { status: { in: ['offline', 'partial_success'] }, endsAt: { lte: now } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
    });
    for (const emergency of due) {
      const claimed = await this.prisma.storeEmergency.updateMany({
        where: { id: emergency.id, status: { in: ['offline', 'partial_success'] }, endsAt: { lte: now } },
        data: { status: 'restoring', errorMessage: null },
      });
      if (claimed.count === 0) continue;
      try {
        await this.queue.add('set-store-emergency-status', { emergencyId: emergency.id, action: 'restore' }, {
          jobId: `${emergency.id}-restore`,
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 500,
        });
        this.logger.log(`Queued automatic restore for store emergency ${emergency.id}`);
      } catch (error) {
        await this.prisma.storeEmergency.update({
          where: { id: emergency.id },
          data: { status: 'restore_failed', errorMessage: `Could not enqueue restore: ${(error as Error).message}`, finishedAt: new Date() },
        });
      }
    }
  }
}
