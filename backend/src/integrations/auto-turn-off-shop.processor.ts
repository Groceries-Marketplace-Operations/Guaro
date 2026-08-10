import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { decrypt } from '../common/crypto.util';
import { fetchShopIdMap, getAuthToken } from '../queue/handlers/didi-food.util';
import {
  AutoTurnOffCancelledError,
  buildStockList,
  callStockApi,
  resolveShopStockCandidates,
  ShopStockCandidate,
  ShopResult,
  StockEndpoint,
} from './auto-turn-off-api.util';

type ShopPhase = 'local';
type WorkerJobData =
  | { shopExecutionId: string; phase: ShopPhase }
  | { executionId: string; phase: 'advance' };

type ShopTarget = Prisma.AutoTurnOffShopExecutionGetPayload<{
  include: {
    execution: {
      include: {
        pool: true;
        rule: {
          include: {
            brand: {
              include: {
                application: { select: { appId: true; appSecret: true } };
              };
            };
          };
        };
      };
    };
  };
}>;

@Injectable()
@Processor('auto-turn-off-shop', { concurrency: 24 })
export class AutoTurnOffShopProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoTurnOffShopProcessor.name);
  private readonly activeByApplication = new Map<string, number>();
  private readonly waitingByApplication = new Map<string, Array<() => void>>();
  private readonly maxPerApplication = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhookSenderService,
    @InjectQueue('auto-turn-off-shop') private readonly shopQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<WorkerJobData>): Promise<void> {
    if (job.data.phase === 'advance') {
      await this.continuePipeline(job.data.executionId);
      return;
    }

    const { shopExecutionId } = job.data;
    const claimed = await this.prisma.autoTurnOffShopExecution.updateMany({
      where: { id: shopExecutionId, status: 'pending', currentStep: { in: ['queued_local', 'queued_resolved'] } },
      data: {
        status: 'running',
        currentStep: 'authenticating_local',
        startedAt: new Date(),
        finishedAt: null,
      },
    });
    if (claimed.count === 0) return;

    const target = await this.prisma.autoTurnOffShopExecution.findUnique({
      where: { id: shopExecutionId },
      include: {
        execution: {
          include: {
            pool: true,
            rule: {
              include: {
                brand: { include: { application: { select: { appId: true, appSecret: true } } } },
              },
            },
          },
        },
      },
    });
    if (!target) return;

    const { execution } = target;
    const { rule } = execution;
    const application = rule.brand.application;
    if (!application || !target.appShopId) {
      await this.finishShop(target.id, {
        shopId: target.shopId,
        appShopId: target.appShopId ?? '-',
        endpoint: rule.stockEndpoint as StockEndpoint,
        success: false,
        itemsSucceeded: 0,
        itemsFailed: rule.upcs.length,
        error: !application ? 'Brand has no application linked' : 'Missing app_shop_id',
      }, 3);
      await this.continuePipeline(execution.id);
      return;
    }

    await this.withApplicationSlot(application.appId, async () => {
      try {
        await this.ensureActive(target.id, execution.id);
        const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
        const appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
        const authToken = await getAuthToken(application.appId, appSecret, target.appShopId!);
        await this.processLocalPhase(target, authToken);
      } catch (error) {
        if (error instanceof AutoTurnOffCancelledError) {
          await this.prisma.autoTurnOffShopExecution.updateMany({
            where: { id: target.id, status: { in: ['pending', 'running'] } },
            data: { status: 'cancelled', currentStep: 'cancelled', finishedAt: new Date() },
          });
          return;
        }
        this.logger.error(`local catalog phase failed for shop ${target.shopId}: ${(error as Error).message}`);
        await this.finishShop(target.id, {
          shopId: target.shopId,
          appShopId: target.appShopId!,
          endpoint: rule.stockEndpoint as StockEndpoint,
          success: false,
          itemsSucceeded: 0,
          itemsFailed: rule.upcs.length,
          failedItems: rule.upcs.map(upc => ({ upc, reason: (error as Error).message })),
          error: (error as Error).message,
        }, 3);
      }
    });
    await this.continuePipeline(execution.id);
  }

  private async processLocalPhase(
    target: ShopTarget,
    authToken: string,
  ) {
    const { execution } = target;
    const { rule } = execution;
    const endpoint = rule.stockEndpoint as StockEndpoint;
    const [catalogRows, shopRows] = await Promise.all([
      this.prisma.brandItem.findMany({
        where: {
          brandId: rule.brandId,
          upc: { in: rule.upcs },
        },
        select: { upc: true, appItemId: true, name: true },
      }),
      this.prisma.brandShopItem.findMany({
        where: {
          brandId: rule.brandId,
          shopId: target.shopId,
          upc: { in: rule.upcs },
        },
        select: { upc: true, appItemId: true, name: true, available: true },
      }),
    ]);
    const catalogItems: ShopStockCandidate[] = catalogRows
      .filter((item): item is typeof item & { upc: string } => Boolean(item.upc))
      .map(item => ({ upc: item.upc, appItemId: item.appItemId, name: item.name }));
    const knownShopItems = shopRows
      .filter((item): item is typeof item & { upc: string } => Boolean(item.upc))
      .map(item => ({
        upc: item.upc,
        appItemId: item.appItemId,
        name: item.name,
        available: item.available,
      }));
    const cached = resolveShopStockCandidates(catalogItems, knownShopItems, rule.upcs);

    await this.advanceStep(target.id, execution.id, `matching_local_upcs:${target.shopId}`);
    await this.advanceStep(target.id, execution.id, `updating_local_stock:${target.shopId}`);

    let localResult: Omit<ShopResult, 'shopId' | 'appShopId' | 'endpoint'> = {
      success: cached.candidates.length === 0,
      itemsSucceeded: 0,
      itemsFailed: 0,
    };
    let apiCompleted = false;
    if (cached.candidates.length > 0) {
      await this.ensureActive(target.id, execution.id);
      try {
        localResult = await callStockApi(
          endpoint,
          authToken,
          buildStockList(cached.candidates.map(item => item.appItemId), rule.stockValue),
        );
        apiCompleted = true;
      } catch (error) {
        const reason = (error as Error).message;
        localResult = {
          success: false,
          itemsSucceeded: 0,
          itemsFailed: cached.candidates.length,
          failedItems: cached.candidates.map(item => ({ appItemId: item.appItemId, upc: item.upc, reason })),
          error: reason,
        };
      }
    }

    if (apiCompleted) {
      await this.persistShopItemKnowledge(
        rule.brandId,
        target.shopId,
        cached.candidates,
        localResult,
      );
    }

    const missingFailures = cached.missingUpcs.map(upc => ({
      upc,
      reason: 'UPC is not available in the local brand catalog; Auto Turn Off does not download menus',
    }));
    const unavailableFailures = cached.unavailableUpcs.map(upc => ({
      upc,
      reason: 'All known app_item_id candidates were rejected by this store in an earlier execution',
    }));
    const catalogByItemId = new Map(cached.candidates.map(item => [item.appItemId, item]));
    const apiFailedItems = (localResult.failedItems ?? []).map(item => {
      const catalogItem = item.appItemId ? catalogByItemId.get(item.appItemId) : undefined;
      return {
        ...item,
        upc: item.upc ?? catalogItem?.upc,
      };
    });
    const failedItems = [...apiFailedItems, ...missingFailures, ...unavailableFailures];
    const itemsFailed = localResult.itemsFailed + cached.missingUpcs.length + cached.unavailableUpcs.length;
    const errors = [
      localResult.error,
      cached.missingUpcs.length > 0
        ? `${cached.missingUpcs.length} UPC(s) are missing from the local brand catalog`
        : undefined,
      cached.unavailableUpcs.length > 0
        ? `${cached.unavailableUpcs.length} UPC(s) have no valid app_item_id candidate for this store`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    const successfulItems = (localResult.successfulItems ?? []).map(item => {
      const catalogItem = catalogByItemId.get(item.appItemId);
      return {
        appItemId: item.appItemId,
        upc: catalogItem?.upc ?? item.upc,
        name: catalogItem?.name ?? item.name,
        confirmation: item.confirmation,
      };
    });
    await this.finishShop(target.id, {
      shopId: target.shopId,
      appShopId: target.appShopId!,
      endpoint,
      ...localResult,
      success: itemsFailed === 0,
      itemsFailed,
      requestedUpcs: rule.upcs.length,
      matchedUpcs: cached.matchedUpcs,
      successfulItems: successfulItems.length > 0 ? successfulItems : undefined,
      missingUpcs: cached.missingUpcs.length > 0 ? cached.missingUpcs : undefined,
      failedItems: failedItems.length > 0 ? failedItems : undefined,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      menuSource: 'catalog',
    }, 1);
  }

  private async persistShopItemKnowledge(
    brandId: string,
    shopId: string,
    candidates: ShopStockCandidate[],
    result: Omit<ShopResult, 'shopId' | 'appShopId' | 'endpoint'>,
  ) {
    const candidatesById = new Map(candidates.map(item => [item.appItemId, item]));
    const observations = new Map<string, {
      candidate: ShopStockCandidate;
      available: boolean;
      lastError: string | null;
    }>();
    for (const item of result.successfulItems ?? []) {
      if (item.confirmation !== 'confirmed') continue;
      const candidate = candidatesById.get(item.appItemId);
      if (candidate) observations.set(item.appItemId, { candidate, available: true, lastError: null });
    }
    for (const item of result.failedItems ?? []) {
      if (!item.appItemId || !this.isMissingAppItemId(item.reason)) continue;
      const candidate = candidatesById.get(item.appItemId);
      if (candidate) observations.set(item.appItemId, { candidate, available: false, lastError: item.reason });
    }

    const values = [...observations.values()];
    for (let offset = 0; offset < values.length; offset += 100) {
      const now = new Date();
      const chunk = values.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.map(({ candidate, available, lastError }) =>
        this.prisma.brandShopItem.upsert({
          where: {
            brandId_shopId_appItemId: { brandId, shopId, appItemId: candidate.appItemId },
          },
          create: {
            brandId,
            shopId,
            name: candidate.name ?? candidate.upc,
            upc: candidate.upc,
            appItemId: candidate.appItemId,
            available,
            source: 'stock_probe',
            lastError,
            lastSeenAt: now,
          },
          update: {
            name: candidate.name ?? candidate.upc,
            upc: candidate.upc,
            available,
            lastError,
            lastSeenAt: now,
          },
        }),
      ));
    }
  }

  private isMissingAppItemId(reason: string) {
    return /app[_\s-]?item[_\s-]?id.*(?:does not exist|not exist|not found|invalid)/i.test(reason);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WorkerJobData> | undefined, error: Error) {
    if (!job) return;
    if (job.data.phase === 'advance') {
      await this.failExecution(job.data.executionId, error.message);
      return;
    }
    const shop = await this.prisma.autoTurnOffShopExecution.findUnique({
      where: { id: job.data.shopExecutionId },
      include: { execution: { include: { rule: true } } },
    });
    if (!shop) return;
    await this.finishShop(shop.id, {
      shopId: shop.shopId,
      appShopId: shop.appShopId ?? '-',
      endpoint: shop.execution.rule.stockEndpoint as StockEndpoint,
      success: false,
      itemsSucceeded: shop.itemsSucceeded,
      itemsFailed: Math.max(shop.itemsFailed, shop.execution.rule.upcs.length - shop.itemsSucceeded),
      error: error.message,
    }, 3);
    await this.continuePipeline(shop.executionId);
  }

  private async ensureActive(shopExecutionId: string, executionId: string) {
    const [shop, execution] = await Promise.all([
      this.prisma.autoTurnOffShopExecution.findUnique({ where: { id: shopExecutionId }, select: { status: true } }),
      this.prisma.autoTurnOffExecution.findUnique({ where: { id: executionId }, select: { status: true } }),
    ]);
    if (shop?.status !== 'running' || execution?.status !== 'running') throw new AutoTurnOffCancelledError();
  }

  private async advanceStep(shopExecutionId: string, executionId: string, currentStep: string) {
    const shop = await this.prisma.autoTurnOffShopExecution.updateMany({
      where: { id: shopExecutionId, status: 'running' },
      data: { currentStep },
    });
    if (shop.count === 0) throw new AutoTurnOffCancelledError();
    await this.advanceExecution(executionId, currentStep, 1);
  }

  private async advanceExecution(executionId: string, currentStep: string, amount: number) {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "auto_turn_off_execution"
      SET "current_step" = ${currentStep},
          "progress_current" = LEAST("progress_total", "progress_current" + ${amount}),
          "progress_percent" = LEAST(
            99,
            FLOOR((LEAST("progress_total", "progress_current" + ${amount})::numeric / GREATEST("progress_total", 1)) * 100)::integer
          )
      WHERE "id" = ${executionId}::uuid AND "status" = 'running'
    `);
  }

  private async finishShop(shopExecutionId: string, result: ShopResult, remainingProgress: number) {
    const current = await this.prisma.autoTurnOffShopExecution.findUnique({
      where: { id: shopExecutionId },
      select: { executionId: true },
    });
    if (!current) return;
    const status = result.success
      ? 'done'
      : (result.itemsSucceeded > 0 ? 'partial_success' : 'failed');
    const updated = await this.prisma.autoTurnOffShopExecution.updateMany({
      where: { id: shopExecutionId, status: { in: ['pending', 'running'] } },
      data: {
        status,
        currentStep: status === 'done' ? 'completed' : status,
        itemsSucceeded: result.itemsSucceeded,
        itemsFailed: result.itemsFailed,
        result: result as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) return;
    await this.advanceExecution(
      current.executionId,
      status === 'done' ? 'processing_local_data' : status === 'partial_success' ? 'shop_partial_success' : 'shop_failed',
      remainingProgress,
    );
  }

  private async continuePipeline(executionId: string): Promise<void> {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      select: { status: true },
    });
    if (execution?.status !== 'running') return;

    const nextLocal = await this.prisma.autoTurnOffShopExecution.findFirst({
      where: {
        executionId,
        status: 'pending',
        currentStep: { in: ['queued_local', 'queued_resolved'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (nextLocal) {
      await this.enqueueShop(nextLocal.id, 'local');
      return;
    }

    const unresolvedCount = await this.prisma.autoTurnOffShopExecution.count({
      where: { executionId, status: 'pending', currentStep: 'waiting_shop_resolution' },
    });
    if (unresolvedCount > 0) {
      await this.resolveDeferredShops(executionId);
      await this.continuePipeline(executionId);
      return;
    }

    const legacyMenuStep = await this.prisma.autoTurnOffShopExecution.findFirst({
      where: { executionId, status: 'pending', currentStep: 'waiting_menu_download' },
      orderBy: { createdAt: 'asc' },
      include: { execution: { include: { rule: true } } },
    });
    if (legacyMenuStep) {
      const previous = (legacyMenuStep.result ?? {}) as unknown as ShopResult;
      const missingUpcs = previous.missingUpcs ?? legacyMenuStep.execution.rule.upcs;
      const message = `${missingUpcs.length} UPC(s) are missing from the local brand catalog; menu download was removed`;
      await this.finishShop(legacyMenuStep.id, {
        ...previous,
        shopId: legacyMenuStep.shopId,
        appShopId: legacyMenuStep.appShopId ?? '-',
        endpoint: legacyMenuStep.execution.rule.stockEndpoint as StockEndpoint,
        success: false,
        itemsSucceeded: previous.itemsSucceeded ?? legacyMenuStep.itemsSucceeded,
        itemsFailed: (previous.itemsFailed ?? legacyMenuStep.itemsFailed) + missingUpcs.length,
        missingUpcs,
        failedItems: [
          ...(previous.failedItems ?? []),
          ...missingUpcs.map(upc => ({ upc, reason: message })),
        ],
        error: message,
        menuSource: 'catalog',
      }, 1);
      await this.continuePipeline(executionId);
      return;
    }
    await this.finalizeIfComplete(executionId);
  }

  private async resolveDeferredShops(executionId: string) {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      include: {
        rule: {
          include: { brand: { include: { application: { select: { appId: true, appSecret: true } } } } },
        },
      },
    });
    if (!execution || execution.status !== 'running') return;
    const deferred = await this.prisma.autoTurnOffShopExecution.findMany({
      where: { executionId, status: 'pending', currentStep: 'waiting_shop_resolution' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, shopId: true },
    });
    if (deferred.length === 0) return;

    await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: { currentStep: 'resolving_deferred_shops' },
    });
    const application = execution.rule.brand.application;
    let mappings = new Map<string, string>();
    let resolutionError: string | undefined;
    if (!application) {
      resolutionError = 'Brand has no application linked';
    } else {
      try {
        const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
        const appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
        mappings = await this.withApplicationSlot(application.appId, () =>
          fetchShopIdMap(application.appId, appSecret, deferred.map(shop => shop.shopId)));
      } catch (error) {
        resolutionError = `Could not resolve deferred shop_id values from DiDi: ${(error as Error).message}`;
      }
    }

    const now = new Date();
    for (const shop of deferred) {
      const appShopId = mappings.get(shop.shopId);
      if (appShopId) {
        await this.prisma.autoTurnOffShopExecution.updateMany({
          where: { id: shop.id, status: 'pending', currentStep: 'waiting_shop_resolution' },
          data: { appShopId, currentStep: 'queued_resolved' },
        });
        continue;
      }
      const message = resolutionError ?? 'shop_id was not found in the DiDi shop list for this application';
      const result: ShopResult = {
        shopId: shop.shopId,
        appShopId: '-',
        endpoint: execution.rule.stockEndpoint as StockEndpoint,
        success: false,
        itemsSucceeded: 0,
        itemsFailed: execution.rule.upcs.length,
        failedItems: execution.rule.upcs.map(upc => ({ upc, reason: message })),
        error: message,
      };
      await this.prisma.autoTurnOffShopExecution.updateMany({
        where: { id: shop.id, status: 'pending', currentStep: 'waiting_shop_resolution' },
        data: {
          status: 'failed',
          currentStep: 'shop_not_found',
          itemsFailed: execution.rule.upcs.length,
          result: result as unknown as Prisma.InputJsonValue,
          finishedAt: now,
        },
      });
      await this.advanceExecution(executionId, 'resolving_deferred_shops', 3);
    }

    const resolved = deferred
      .map(shop => ({ shopId: shop.shopId, appShopId: mappings.get(shop.shopId) }))
      .filter((shop): shop is { shopId: string; appShopId: string } => Boolean(shop.appShopId));
    await this.persistResolvedShops(execution.rule.brandId, resolved);
    if (resolved.length > 0) {
      const previous = execution.rule.resolvedShopIds
        && typeof execution.rule.resolvedShopIds === 'object'
        && !Array.isArray(execution.rule.resolvedShopIds)
        ? execution.rule.resolvedShopIds as Record<string, string>
        : {};
      await this.prisma.autoTurnOffRule.update({
        where: { id: execution.ruleId },
        data: {
          resolvedShopIds: {
            ...previous,
            ...Object.fromEntries(resolved.map(shop => [shop.shopId, shop.appShopId])),
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async persistResolvedShops(
    brandId: string,
    resolved: Array<{ shopId: string; appShopId: string }>,
  ) {
    for (let offset = 0; offset < resolved.length; offset += 100) {
      const chunk = resolved.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.map(shop => this.prisma.shop.upsert({
        where: { shopId: shop.shopId },
        create: { ...shop, brandId, status: 'integrated' },
        update: { appShopId: shop.appShopId, brandId, deletedAt: null },
      })));
    }
  }

  private async enqueueShop(shopExecutionId: string, phase: ShopPhase) {
    await this.shopQueue.add('turn-off-shop-items', { shopExecutionId, phase }, {
      jobId: `${shopExecutionId}-${phase}`,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  private async failExecution(executionId: string, message: string) {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      select: {
        status: true,
        progressTotal: true,
        shops: { select: { status: true, itemsSucceeded: true, itemsFailed: true } },
      },
    });
    if (!execution || !['pending', 'running'].includes(execution.status)) return;
    const shopsSucceeded = execution.shops.filter(shop => shop.status === 'done').length;
    const shopsPartial = execution.shops.filter(shop => shop.status === 'partial_success').length;
    const shopsFailed = execution.shops.length - shopsSucceeded - shopsPartial;
    const itemsSucceeded = execution.shops.reduce((sum, shop) => sum + shop.itemsSucceeded, 0);
    const itemsFailed = execution.shops.reduce((sum, shop) => sum + shop.itemsFailed, 0);
    await this.prisma.$transaction([
      this.prisma.autoTurnOffExecution.updateMany({
        where: { id: executionId, status: { in: ['pending', 'running'] } },
        data: {
          status: itemsSucceeded > 0 ? 'partial_success' : 'failed',
          currentStep: 'worker_failed',
          errorMessage: message,
          finishedAt: new Date(),
          shopsSucceeded,
          shopsPartial,
          shopsFailed,
          itemsTurnedOff: itemsSucceeded,
          itemsFailed,
          progressCurrent: execution.progressTotal,
          progressPercent: 100,
        },
      }),
      this.prisma.autoTurnOffShopExecution.updateMany({
        where: { executionId, status: { in: ['pending', 'running'] } },
        data: { status: 'cancelled', currentStep: 'worker_failed', finishedAt: new Date() },
      }),
    ]);
  }

  private async finalizeIfComplete(executionId: string) {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      include: {
        pool: true,
        rule: { include: { brand: true } },
        shops: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!execution || execution.status !== 'running') return;
    if (execution.shops.some(shop => shop.status === 'pending' || shop.status === 'running')) return;

    const complete = execution.shops.length > 0 && execution.shops.every(shop => shop.status === 'done');
    const shopsSucceeded = execution.shops.filter(shop => shop.status === 'done').length;
    const shopsPartial = execution.shops.filter(shop => shop.status === 'partial_success').length;
    const shopsFailed = execution.shops.length - shopsSucceeded - shopsPartial;
    const itemsTurnedOff = execution.shops.reduce((sum, shop) => sum + shop.itemsSucceeded, 0);
    const itemsFailed = execution.shops.reduce((sum, shop) => sum + shop.itemsFailed, 0);
    const finalStatus = complete ? 'done' : (itemsTurnedOff > 0 ? 'partial_success' : 'failed');
    const results = execution.shops.map(shop => shop.result).filter(Boolean) as Prisma.JsonValue[];
    const failedResult = execution.shops.find(
      shop => shop.status === 'failed' || shop.status === 'partial_success',
    )?.result as Record<string, unknown> | null;
    const errorMessage = complete ? null : String(failedResult?.error ?? 'One or more shop workers failed');
    const finalized = await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: {
        status: finalStatus,
        currentStep: complete ? 'completed' : finalStatus,
        finishedAt: new Date(),
        shopsSucceeded,
        shopsPartial,
        shopsFailed,
        itemsTurnedOff,
        itemsFailed,
        progressCurrent: execution.progressTotal,
        progressPercent: 100,
        errorMessage,
        logs: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
    if (finalized.count === 0) return;

    await this.notify(
      execution.pool.webhookId,
      execution.pool.name,
      execution.rule.name,
      execution.rule.brand.brandName,
      execution.totalShops,
      shopsSucceeded,
      itemsTurnedOff,
      finalStatus,
    );
  }

  private async withApplicationSlot<T>(appId: string, action: () => Promise<T>): Promise<T> {
    await this.acquireApplicationSlot(appId);
    try {
      return await action();
    } finally {
      this.releaseApplicationSlot(appId);
    }
  }

  private async acquireApplicationSlot(appId: string) {
    const active = this.activeByApplication.get(appId) ?? 0;
    if (active < this.maxPerApplication) {
      this.activeByApplication.set(appId, active + 1);
      return;
    }
    await new Promise<void>(resolve => {
      const waiters = this.waitingByApplication.get(appId) ?? [];
      waiters.push(resolve);
      this.waitingByApplication.set(appId, waiters);
    });
  }

  private releaseApplicationSlot(appId: string) {
    const waiters = this.waitingByApplication.get(appId) ?? [];
    const next = waiters.shift();
    if (next) {
      this.waitingByApplication.set(appId, waiters);
      next();
      return;
    }
    const active = Math.max((this.activeByApplication.get(appId) ?? 1) - 1, 0);
    if (active === 0) this.activeByApplication.delete(appId);
    else this.activeByApplication.set(appId, active);
  }

  private async notify(
    webhookId: string | null,
    poolName: string,
    ruleName: string,
    brandName: string,
    totalShops: number,
    shopsSucceeded: number,
    itemsTurnedOff: number,
    status: 'done' | 'partial_success' | 'failed',
  ) {
    if (!webhookId) return;
    await this.webhooks.sendToWebhook(webhookId, {
      text: `**Auto Turn Off Items — ${poolName}**`,
      attachments: [{
        title: ruleName,
        text: [
          `**Brand:** ${brandName}`,
          `**Status:** ${status === 'done' ? 'Done' : status === 'partial_success' ? 'Partial success' : 'Failed'}`,
          `**Shops:** ${shopsSucceeded}/${totalShops}`,
          `**Items set to stock 0:** ${itemsTurnedOff}`,
        ].join('\n'),
        color: status === 'done' ? '#00C853' : status === 'partial_success' ? '#FFB300' : '#D50000',
      }],
    });
  }
}
