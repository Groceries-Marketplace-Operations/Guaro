import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { downloadMenu } from '../integrations/auto-turn-off-api.util';
import { PrismaService } from '../prisma/prisma.service';
import { fetchShopIdMap, getAuthToken, isRawShopId, parseJsonKeepingIds } from '../queue/handlers/didi-food.util';
import { submitGroceryBatch } from './grocery-menu-upload.util';
import { prepareActivityPriceUpdates } from './upc-activity-price.util';

class UpcActivityPriceCancelledError extends Error {}

type ShopOutcome = 'updated' | 'partial_success' | 'would_update' | 'already_current' | 'upc_not_found' | 'failed';

interface ShopResult {
  shopId: string;
  appShopId?: string;
  outcome: ShopOutcome;
  matchedItems: number;
  changedItems: number;
  exportTaskId?: string;
  uploadReferenceId?: string;
  error?: string;
}

@Injectable()
@Processor('upc-activity-price', { concurrency: 1 })
export class UpcActivityPriceProcessor extends WorkerHost {
  private readonly logger = new Logger(UpcActivityPriceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const started = Date.now();
    const claimed = await this.prisma.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), errorMessage: null },
    });
    if (!claimed.count) return;

    const execution = await this.prisma.upcActivityPriceExecution.findUnique({
      where: { id: executionId },
      include: { rule: { include: { application: true } } },
    });
    if (!execution) return;
    const { rule } = execution;
    const results: ShopResult[] = [];

    try {
      this.assertRemoteWriteGate(execution.dryRun);
      const encryptionKey = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      const appSecret = decrypt(rule.application.appSecret, encryptionKey);
      const targets = await this.resolveTargets(
        rule.applicationId,
        rule.shopIds,
        rule.application.appId,
        appSecret,
      );
      await this.mapWithConcurrency(targets, rule.storeConcurrency, async target => {
        await this.ensureActive(executionId);
        await this.prisma.upcActivityPriceExecution.update({
          where: { id: executionId },
          data: { currentShopId: target.shopId },
        });
        if (!target.appShopId) {
          results.push({
            shopId: target.shopId,
            outcome: 'failed',
            matchedItems: 0,
            changedItems: 0,
            error: 'shop_id was not found locally or in POST /v1/shop/shop/list',
          });
          await this.saveProgress(executionId, results);
          return;
        }
        try {
          let authToken = await getAuthToken(rule.application.appId, appSecret, target.appShopId);
          const downloaded = await downloadMenu(
            authToken,
            () => this.ensureActive(executionId),
            async () => {
              authToken = await getAuthToken(rule.application.appId, appSecret, target.appShopId!);
              return authToken;
            },
            { rateLimitKey: rule.application.appId },
          );
          const menu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
          const prepared = prepareActivityPriceUpdates(menu, rule.targetUpc);
          if (!prepared.matches.length) {
            results.push({
              shopId: target.shopId,
              appShopId: target.appShopId,
              outcome: 'upc_not_found',
              matchedItems: 0,
              changedItems: 0,
              exportTaskId: downloaded.taskId,
            });
          } else if (!prepared.updates.length) {
            results.push({
              shopId: target.shopId,
              appShopId: target.appShopId,
              outcome: 'already_current',
              matchedItems: prepared.matches.length,
              changedItems: 0,
              exportTaskId: downloaded.taskId,
            });
          } else if (execution.dryRun) {
            results.push({
              shopId: target.shopId,
              appShopId: target.appShopId,
              outcome: 'would_update',
              matchedItems: prepared.matches.length,
              changedItems: prepared.updates.length,
              exportTaskId: downloaded.taskId,
            });
          } else {
            await this.ensureActive(executionId);
            this.assertRemoteWriteGate(false);
            const upload = await submitGroceryBatch(authToken, {
              menus: [], categories: [], categoryIds: [], items: prepared.updates,
            }, 'updateItemsync', 0);
            if (!('acceptedCount' in upload)) throw new Error('updateItemsync returned an unexpected asynchronous response');
            results.push({
              shopId: target.shopId,
              appShopId: target.appShopId,
              outcome: upload.acceptedCount === 0
                ? 'failed'
                : upload.failedItems.length ? 'partial_success' : 'updated',
              matchedItems: prepared.matches.length,
              changedItems: upload.acceptedCount,
              exportTaskId: downloaded.taskId,
              uploadReferenceId: upload.referenceId,
              error: upload.failedItems.length
                ? upload.failedItems.map(item => `${item.appItemId}: ${item.reason}`).join('; ')
                : upload.acceptedCount > 0 ? undefined : 'No item was accepted',
            });
          }
        } catch (error) {
          if (error instanceof UpcActivityPriceCancelledError) throw error;
          results.push({
            shopId: target.shopId,
            appShopId: target.appShopId,
            outcome: 'failed',
            matchedItems: 0,
            changedItems: 0,
            error: this.safeError(error),
          });
        }
        await this.saveProgress(executionId, results);
      });

      await this.ensureActive(executionId);
      const successfulShops = results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length;
      const skippedShops = results.filter(value => value.outcome === 'upc_not_found').length;
      const failedShops = results.filter(value => value.outcome === 'failed').length;
      const partialShops = results.filter(value => value.outcome === 'partial_success').length;
      const status: AutoOpenStatus = successfulShops === 0
        ? AutoOpenStatus.failed
        : failedShops || skippedShops || results.some(value => value.outcome === 'partial_success')
          ? AutoOpenStatus.partial_success : AutoOpenStatus.done;
      const now = new Date();
      const errorMessage = status === AutoOpenStatus.done
        ? null
        : `${failedShops} store(s) failed; ${partialShops} store(s) were partially updated; ${skippedShops} store(s) did not contain UPC ${rule.targetUpc}`;
      await this.prisma.$transaction([
        this.prisma.upcActivityPriceExecution.update({
          where: { id: executionId },
          data: {
            status,
            finishedAt: now,
            durationMs: Date.now() - started,
            currentShopId: null,
            processedShops: results.length,
            successfulShops,
            skippedShops,
            failedShops,
            errorMessage,
            result: { targetUpc: rule.targetUpc, dryRun: execution.dryRun, shops: results } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.upcActivityPriceRule.update({ where: { id: rule.id }, data: { lastRunAt: now } }),
      ]);
      this.logger.log(`UPC activity-price ${rule.name}: ${status}; ${successfulShops}/${results.length}; dryRun=${execution.dryRun}`);
    } catch (error) {
      if (error instanceof UpcActivityPriceCancelledError) return;
      await this.fail(executionId, this.safeError(error), results, started);
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    if (!job?.data.executionId) return;
    await this.prisma.upcActivityPriceExecution.updateMany({
      where: { id: job.data.executionId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), currentShopId: null, errorMessage: this.safeError(error) },
    });
  }

  private assertRemoteWriteGate(dryRun: boolean) {
    const enabled = this.config.get('UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED', 'false').trim().toLowerCase() === 'true';
    if (!dryRun && !enabled) throw new Error('Live UPC activity-price writes are disabled by the server safety gate');
  }

  private async resolveTargets(applicationId: string, requested: string[], appId: string, appSecret: string) {
    const local = await this.prisma.shop.findMany({
      where: {
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
        OR: [{ shopId: { in: requested } }, { appShopId: { in: requested } }],
      },
      select: { shopId: true, appShopId: true },
    });
    const localByShopId = new Map(local.map(shop => [shop.shopId, shop.appShopId]));
    const localByAppShopId = new Map(local.map(shop => [shop.appShopId, shop.appShopId]));
    const unresolved = requested.filter(value => isRawShopId(value) && !localByShopId.has(value));
    const remote = unresolved.length ? await fetchShopIdMap(appId, appSecret, unresolved) : new Map<string, string>();
    return requested.map(shopId => ({
      shopId,
      appShopId: localByShopId.get(shopId)
        ?? localByAppShopId.get(shopId)
        ?? (isRawShopId(shopId) ? remote.get(shopId) : shopId),
    }));
  }

  private async mapWithConcurrency<T>(values: T[], concurrency: number, action: (value: T) => Promise<void>) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
      while (cursor < values.length) await action(values[cursor++]);
    });
    await Promise.all(workers);
  }

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.upcActivityPriceExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.status !== 'running' || execution.cancelRequested) throw new UpcActivityPriceCancelledError();
  }

  private async saveProgress(executionId: string, results: ShopResult[]) {
    await this.prisma.upcActivityPriceExecution.update({
      where: { id: executionId },
      data: {
        processedShops: results.length,
        successfulShops: results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length,
        skippedShops: results.filter(value => value.outcome === 'upc_not_found').length,
        failedShops: results.filter(value => value.outcome === 'failed').length,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async fail(executionId: string, message: string, results: ShopResult[], started: number) {
    await this.prisma.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        currentShopId: null,
        processedShops: results.length,
        successfulShops: results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length,
        skippedShops: results.filter(value => value.outcome === 'upc_not_found').length,
        failedShops: results.filter(value => value.outcome === 'failed').length,
        errorMessage: message,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private safeError(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
      .replace(/app_secret[=:]\s*[^\s,;&]+/gi, 'app_secret=<redacted>')
      .replace(/auth_token[=:]\s*[^\s,;&]+/gi, 'auth_token=<redacted>')
      .slice(0, 1200);
  }
}
