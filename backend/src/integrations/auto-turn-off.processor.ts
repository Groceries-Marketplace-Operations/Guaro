import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/crypto.util';
import { AutoTurnOffCancelledError } from './auto-turn-off-api.util';
import { timezoneForCountry } from './auto-fetch-time.util';
import { nextAutoTurnOffOccurrence } from './auto-turn-off-time.util';

@Injectable()
export class AutoTurnOffCoordinator {
  private readonly logger = new Logger(AutoTurnOffCoordinator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('auto-turn-off-shop') private readonly shopQueue: Queue,
  ) {}

  async process(executionId: string): Promise<void> {
    const claimed = await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: 'pending' },
      data: {
        status: 'running',
        startedAt: new Date(),
        finishedAt: null,
        currentStep: 'preparing',
        progressCurrent: 0,
        progressTotal: 1,
        progressPercent: 0,
        errorMessage: null,
      },
    });
    if (claimed.count === 0) return;

    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      include: {
        pool: true,
        rule: {
          include: {
            brand: { include: { application: { select: { appId: true, appSecret: true } } } },
          },
        },
      },
    });
    if (!execution) return;

    const { rule } = execution;
    const now = new Date();
    if (rule.endsAt && rule.endsAt <= now) {
      await this.prisma.autoTurnOffRule.update({ where: { id: rule.id }, data: { active: false } });
      await this.failExecution(executionId, 'Rule reached its automatic end date before execution started');
      return;
    }

    const nextAfterCooldown = rule.stockEndpoint === 'setStock'
      ? nextAutoTurnOffOccurrence({
          startsAt: rule.startsAt,
          intervalMinutes: rule.intervalMinutes,
          scheduleMode: rule.scheduleMode,
          executionTimes: rule.executionTimes,
          timezone: timezoneForCountry(execution.pool.country),
          after: new Date(now.getTime() + 10 * 60_000),
        })
      : rule.nextRunAt;
    await this.prisma.autoTurnOffRule.update({
      where: { id: rule.id },
      data: {
        lastRunAt: now,
        nextRunAt: execution.trigger === 'manual'
          && rule.stockEndpoint === 'setStock'
          && rule.nextRunAt < nextAfterCooldown
          ? nextAfterCooldown
          : undefined,
      },
    });

    if (!rule.brand.application) {
      await this.failExecutionWithShopResults(
        executionId,
        rule,
        new Map(),
        'Brand has no application linked',
      );
      return;
    }

    const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
    try {
      if (encryptionKey) decrypt(rule.brand.application.appSecret, encryptionKey);
    } catch {
      await this.failExecutionWithShopResults(
        executionId,
        rule,
        new Map(),
        'Application credential could not be decrypted with APP_SECRET_ENCRYPTION_KEY',
      );
      return;
    }

    await this.ensureRunning(executionId);
    const localShops = await this.prisma.shop.findMany({
      where: {
        brandId: rule.brandId,
        shopId: { in: rule.shopIds },
        deletedAt: null,
      },
      select: { shopId: true, appShopId: true },
    });
    const shopIdMap = new Map<string, string>(
      localShops.map(shop => [shop.shopId, shop.appShopId]),
    );

    await this.ensureRunning(executionId);
    const shopJobs = rule.shopIds.map(shopId => {
      const id = randomUUID();
      const appShopId = shopIdMap.get(shopId);
      return { id, shopId, appShopId };
    });
    const progressTotal = Math.max(2 + rule.shopIds.length * 3, 1);
    const progressCurrent = 1;

    await this.prisma.$transaction(async tx => {
      const current = await tx.autoTurnOffExecution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (current?.status !== 'running') throw new AutoTurnOffCancelledError();
      await tx.autoTurnOffShopExecution.createMany({
        data: shopJobs.map(item => ({
          id: item.id,
          executionId,
          shopId: item.shopId,
          appShopId: item.appShopId,
          status: 'pending',
          currentStep: item.appShopId ? 'queued_local' : 'waiting_shop_resolution',
          itemsFailed: 0,
          finishedAt: null,
        })),
      });
      await tx.autoTurnOffExecution.update({
        where: { id: executionId },
        data: {
          totalShops: rule.shopIds.length,
          currentStep: 'processing_local_data',
          progressCurrent,
          progressTotal,
          progressPercent: Math.min(99, Math.floor((progressCurrent / progressTotal) * 100)),
        },
      });
    });

    const runnable = shopJobs.filter((item): item is typeof item & { appShopId: string } => Boolean(item.appShopId));

    try {
      await this.ensureRunning(executionId);
      const first = runnable[0];
      const data = first
        ? { shopExecutionId: first.id, phase: 'local' as const }
        : { executionId, phase: 'advance' as const };
      const jobId = first ? `${first.id}-local` : `advance-${executionId}`;
      await this.shopQueue.add('turn-off-shop-items', data, {
        jobId,
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      this.logger.log(
        `Started local-first sequential worker for rule "${rule.name}" `
        + `(${runnable.length} local, ${shopJobs.length - runnable.length} deferred shop(s))`,
      );
    } catch (error) {
      const current = await this.prisma.autoTurnOffExecution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (current?.status === 'cancelled') {
        await this.prisma.autoTurnOffShopExecution.updateMany({
          where: { executionId, status: { in: ['pending', 'running'] } },
          data: { status: 'cancelled', currentStep: 'cancelled', finishedAt: new Date() },
        });
        return;
      }
      const message = `Could not enqueue shop workers: ${(error as Error).message}`;
      await this.prisma.$transaction([
        this.prisma.autoTurnOffExecution.updateMany({
          where: { id: executionId, status: 'running' },
          data: {
            status: 'failed',
            currentStep: 'failed',
            shopsFailed: rule.shopIds.length,
            itemsFailed: rule.shopIds.length * rule.upcs.length,
            errorMessage: message,
            finishedAt: new Date(),
            progressPercent: 100,
          },
        }),
        this.prisma.autoTurnOffShopExecution.updateMany({
          where: { executionId, status: { in: ['pending', 'running'] } },
          data: {
            status: 'failed',
            currentStep: 'queue_failed',
            itemsFailed: rule.upcs.length,
            finishedAt: new Date(),
          },
        }),
      ]);
    }
  }

  private async ensureRunning(executionId: string) {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      select: { status: true },
    });
    if (execution?.status !== 'running') throw new Error('Execution is no longer running');
  }

  async failExecution(executionId: string, message: string) {
    await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        currentStep: 'failed',
        errorMessage: message,
        finishedAt: new Date(),
        progressPercent: 100,
        logs: { error: message } as Prisma.InputJsonValue,
      },
    });
  }

  private async failExecutionWithShopResults(
    executionId: string,
    rule: { shopIds: string[]; upcs: string[]; stockEndpoint: string },
    shopIdMap: Map<string, string>,
    message: string,
  ) {
    const now = new Date();
    const progressTotal = Math.max(2 + rule.shopIds.length * 3, 1);
    await this.prisma.$transaction(async tx => {
      const current = await tx.autoTurnOffExecution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (!current || !['pending', 'running'].includes(current.status)) return;

      await tx.autoTurnOffShopExecution.createMany({
        data: rule.shopIds.map(shopId => ({
          executionId,
          shopId,
          appShopId: shopIdMap.get(shopId),
          status: 'failed',
          currentStep: 'failed',
          itemsFailed: rule.upcs.length,
          result: {
            shopId,
            appShopId: shopIdMap.get(shopId) ?? '-',
            endpoint: rule.stockEndpoint,
            success: false,
            itemsSucceeded: 0,
            itemsFailed: rule.upcs.length,
            requestedUpcs: rule.upcs.length,
            error: message,
          },
          finishedAt: now,
        })),
        skipDuplicates: true,
      });

      await tx.autoTurnOffExecution.update({
        where: { id: executionId },
        data: {
          status: 'failed',
          currentStep: 'failed',
          totalShops: rule.shopIds.length,
          shopsFailed: rule.shopIds.length,
          itemsFailed: rule.shopIds.length * rule.upcs.length,
          errorMessage: message,
          finishedAt: now,
          progressCurrent: progressTotal,
          progressTotal,
          progressPercent: 100,
          logs: { error: message } as Prisma.InputJsonValue,
        },
      });
    });
  }

}
