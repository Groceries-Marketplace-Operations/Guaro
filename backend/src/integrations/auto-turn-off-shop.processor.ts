import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { decrypt } from '../common/crypto.util';
import { getAuthToken } from '../queue/handlers/didi-food.util';
import {
  AutoTurnOffCancelledError,
  callStockApi,
  downloadMenu,
  resolveAppItemIds,
  ShopResult,
  StockEndpoint,
} from './auto-turn-off-api.util';

@Injectable()
@Processor('auto-turn-off-shop', { concurrency: 5 })
export class AutoTurnOffShopProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoTurnOffShopProcessor.name);
  private readonly activeByApplication = new Map<string, number>();
  private readonly waitingByApplication = new Map<string, Array<() => void>>();
  private readonly maxPerApplication = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhookSenderService,
  ) {
    super();
  }

  async process(job: Job<{ shopExecutionId: string }>): Promise<void> {
    const { shopExecutionId } = job.data;
    const claimed = await this.prisma.autoTurnOffShopExecution.updateMany({
      where: { id: shopExecutionId, status: 'pending' },
      data: { status: 'running', currentStep: 'authenticating', startedAt: new Date() },
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
      });
      return;
    }

    await this.withApplicationSlot(application.appId, async () => {
      try {
        await this.ensureActive(target.id, execution.id);
        const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
        const appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
        const authToken = await getAuthToken(application.appId, appSecret, target.appShopId!);

        await this.setCurrentStep(target.id, execution.id, `downloading_menu:${target.shopId}`);
        const menu = await downloadMenu(authToken, () => this.ensureActive(target.id, execution.id));

        await this.advanceStep(target.id, execution.id, `matching_upcs:${target.shopId}`);
        const { appItemIds, matchedUpcs, missingUpcs } = resolveAppItemIds(menu.items, rule.upcs);

        await this.advanceStep(target.id, execution.id, `updating_stock:${target.shopId}`);
        if (appItemIds.length === 0) {
          await this.finishShop(target.id, {
            shopId: target.shopId,
            appShopId: target.appShopId!,
            endpoint: rule.stockEndpoint as StockEndpoint,
            success: false,
            itemsSucceeded: 0,
            itemsFailed: rule.upcs.length,
            menuTaskId: menu.taskId,
            requestedUpcs: rule.upcs.length,
            matchedUpcs: 0,
            missingUpcs,
            failedItems: missingUpcs.map(upc => ({ upc, reason: 'UPC was not found in the exported store menu' })),
            error: `None of the ${rule.upcs.length} UPC(s) were found in the exported store menu`,
          });
          return;
        }

        await this.ensureActive(target.id, execution.id);
        const endpoint = rule.stockEndpoint as StockEndpoint;
        const stockList = appItemIds.map(appItemId => ({ app_item_id: appItemId, stock: 0 }));
        const apiResult = await callStockApi(endpoint, authToken, stockList);
        const missingFailures = missingUpcs.map(upc => ({
          upc,
          reason: 'UPC was not found in the exported store menu',
        }));
        const missingMessage = missingUpcs.length > 0
          ? `${missingUpcs.length} UPC(s) were not found in the exported store menu`
          : undefined;
        await this.finishShop(target.id, {
          shopId: target.shopId,
          appShopId: target.appShopId!,
          endpoint,
          ...apiResult,
          success: apiResult.success && missingUpcs.length === 0,
          itemsFailed: apiResult.itemsFailed + missingUpcs.length,
          menuTaskId: menu.taskId,
          requestedUpcs: rule.upcs.length,
          matchedUpcs,
          missingUpcs: missingUpcs.length ? missingUpcs : undefined,
          failedItems: [...(apiResult.failedItems ?? []), ...missingFailures],
          error: [apiResult.error, missingMessage].filter(Boolean).join('; ') || undefined,
        });
      } catch (error) {
        if (error instanceof AutoTurnOffCancelledError) {
          await this.prisma.autoTurnOffShopExecution.updateMany({
            where: { id: target.id, status: { in: ['pending', 'running'] } },
            data: { status: 'cancelled', currentStep: 'cancelled', finishedAt: new Date() },
          });
          return;
        }
        this.logger.error(`Shop worker failed for ${target.shopId}: ${(error as Error).message}`);
        await this.finishShop(target.id, {
          shopId: target.shopId,
          appShopId: target.appShopId!,
          endpoint: rule.stockEndpoint as StockEndpoint,
          success: false,
          itemsSucceeded: 0,
          itemsFailed: rule.upcs.length,
          error: (error as Error).message,
        });
      }
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ shopExecutionId: string }> | undefined, error: Error) {
    if (!job?.data.shopExecutionId) return;
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
      itemsSucceeded: 0,
      itemsFailed: shop.execution.rule.upcs.length,
      error: error.message,
    });
  }

  private async ensureActive(shopExecutionId: string, executionId: string) {
    const [shop, execution] = await Promise.all([
      this.prisma.autoTurnOffShopExecution.findUnique({ where: { id: shopExecutionId }, select: { status: true } }),
      this.prisma.autoTurnOffExecution.findUnique({ where: { id: executionId }, select: { status: true } }),
    ]);
    if (shop?.status !== 'running' || execution?.status !== 'running') throw new AutoTurnOffCancelledError();
  }

  private async setCurrentStep(shopExecutionId: string, executionId: string, currentStep: string) {
    const [shop] = await this.prisma.$transaction([
      this.prisma.autoTurnOffShopExecution.updateMany({
        where: { id: shopExecutionId, status: 'running' },
        data: { currentStep },
      }),
      this.prisma.autoTurnOffExecution.updateMany({
        where: { id: executionId, status: 'running' },
        data: { currentStep },
      }),
    ]);
    if (shop.count === 0) throw new AutoTurnOffCancelledError();
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

  private async finishShop(shopExecutionId: string, result: ShopResult) {
    const current = await this.prisma.autoTurnOffShopExecution.findUnique({
      where: { id: shopExecutionId },
      select: { executionId: true, currentStep: true },
    });
    if (!current) return;
    const completedSteps = current.currentStep?.startsWith('updating_stock')
      ? 2
      : (current.currentStep?.startsWith('matching_upcs') ? 1 : 0);
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
      status === 'done' ? 'processing_shops' : status === 'partial_success' ? 'shop_partial_success' : 'shop_failed',
      3 - completedSteps,
    );
    await this.finalizeIfComplete(current.executionId);
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
    const itemsTurnedOff = execution.shops.reduce((sum, shop) => sum + shop.itemsSucceeded, 0);
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
        itemsTurnedOff,
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
