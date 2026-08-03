import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/crypto.util';
import { fetchShopIdMap } from '../queue/handlers/didi-food.util';
import { AutoTurnOffCancelledError, ShopResult, StockEndpoint } from './auto-turn-off-api.util';

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
      ? this.nextOccurrence(rule.startsAt, rule.intervalMinutes, new Date(now.getTime() + 10 * 60_000))
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
    const appId = rule.brand.application.appId;
    let appSecret: string;
    try {
      appSecret = encryptionKey
        ? decrypt(rule.brand.application.appSecret, encryptionKey)
        : rule.brand.application.appSecret;
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

    const cachedMappings = rule.resolvedShopIds
      && typeof rule.resolvedShopIds === 'object'
      && !Array.isArray(rule.resolvedShopIds)
      ? Object.entries(rule.resolvedShopIds).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      : [];
    for (const [shopId, appShopId] of cachedMappings) {
      if (!shopIdMap.has(shopId)) shopIdMap.set(shopId, appShopId);
    }
    const unresolvedShopIds = rule.shopIds.filter(shopId => !shopIdMap.has(shopId));

    if (unresolvedShopIds.length > 0) {
      await this.prisma.autoTurnOffExecution.update({
        where: { id: executionId },
        data: { currentStep: 'resolving_shops' },
      });
      try {
        const resolved = await fetchShopIdMap(appId, appSecret, unresolvedShopIds);
        for (const [shopId, appShopId] of resolved) {
          if (unresolvedShopIds.includes(shopId)) shopIdMap.set(shopId, appShopId);
        }
        await this.prisma.autoTurnOffRule.update({
          where: { id: rule.id },
          data: { resolvedShopIds: Object.fromEntries(shopIdMap) as Prisma.InputJsonValue },
        });
      } catch (error) {
        await this.failExecutionWithShopResults(
          executionId,
          rule,
          shopIdMap,
          `Could not resolve shop_id values from DiDi: ${(error as Error).message}`,
        );
        return;
      }
    }

    await this.persistResolvedShops(rule.brandId, rule.shopIds, shopIdMap);

    await this.ensureRunning(executionId);
    const endpoint = rule.stockEndpoint as StockEndpoint;
    const shopJobs = rule.shopIds.map(shopId => {
      const id = randomUUID();
      const appShopId = shopIdMap.get(shopId);
      const result: ShopResult | undefined = appShopId ? undefined : {
        shopId,
        appShopId: '-',
        endpoint,
        success: false,
        itemsSucceeded: 0,
        itemsFailed: rule.upcs.length,
        error: 'shop_id was not found in the DiDi shop list for this application',
      };
      return { id, shopId, appShopId, result };
    });
    const missingCount = shopJobs.filter(item => !item.appShopId).length;
    const progressTotal = Math.max(2 + rule.shopIds.length * 3, 1);
    const progressCurrent = 1 + missingCount * 3;

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
          status: item.appShopId ? 'pending' : 'failed',
          currentStep: item.appShopId ? 'queued' : 'shop_not_found',
          itemsFailed: item.appShopId ? 0 : rule.upcs.length,
          result: item.result as unknown as Prisma.InputJsonValue,
          finishedAt: item.appShopId ? null : now,
        })),
      });
      await tx.autoTurnOffExecution.update({
        where: { id: executionId },
        data: {
          totalShops: rule.shopIds.length,
          currentStep: 'processing_shops',
          progressCurrent,
          progressTotal,
          progressPercent: Math.min(99, Math.floor((progressCurrent / progressTotal) * 100)),
        },
      });
    });

    const runnable = shopJobs.filter((item): item is typeof item & { appShopId: string } => Boolean(item.appShopId));
    if (runnable.length === 0) {
      await this.finalizeWithoutWorkers(executionId);
      return;
    }

    try {
      await this.ensureRunning(executionId);
      const first = runnable[0];
      await this.shopQueue.add('turn-off-shop-items', { shopExecutionId: first.id }, {
        jobId: first.id,
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      this.logger.log(`Started the dedicated sequential worker for rule "${rule.name}" (${runnable.length} shop(s))`);
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
          data: { status: 'failed', currentStep: 'failed', errorMessage: message, finishedAt: new Date(), progressPercent: 100 },
        }),
        this.prisma.autoTurnOffShopExecution.updateMany({
          where: { executionId, status: { in: ['pending', 'running'] } },
          data: { status: 'failed', currentStep: 'queue_failed', finishedAt: new Date() },
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

  private async finalizeWithoutWorkers(executionId: string) {
    const shops = await this.prisma.autoTurnOffShopExecution.findMany({ where: { executionId } });
    const results = shops.map(shop => shop.result).filter(Boolean) as Prisma.JsonValue[];
    const message = shops.find(shop => shop.status === 'failed')?.result as Record<string, unknown> | null;
    await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: {
        status: 'failed',
        currentStep: 'failed',
        finishedAt: new Date(),
        progressCurrent: Math.max(shops.length * 3 + 2, 1),
        progressPercent: 100,
        errorMessage: String(message?.error ?? 'No target shops could be processed'),
        logs: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private nextOccurrence(startsAt: Date, intervalMinutes: number, after: Date) {
    if (startsAt.getTime() >= after.getTime()) return startsAt;
    const intervalMs = intervalMinutes * 60_000;
    const elapsed = after.getTime() - startsAt.getTime();
    return new Date(startsAt.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
  }

  private async persistResolvedShops(brandId: string, shopIds: string[], mappings: Map<string, string>) {
    const resolved = shopIds
      .map(shopId => ({ shopId, appShopId: mappings.get(shopId) }))
      .filter((shop): shop is { shopId: string; appShopId: string } => Boolean(shop.appShopId));
    for (let offset = 0; offset < resolved.length; offset += 100) {
      const chunk = resolved.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.map(shop => this.prisma.shop.upsert({
        where: { shopId: shop.shopId },
        create: {
          shopId: shop.shopId,
          appShopId: shop.appShopId,
          brandId,
          status: 'integrated',
        },
        update: {
          appShopId: shop.appShopId,
          brandId,
          deletedAt: null,
        },
      })));
    }
  }
}
