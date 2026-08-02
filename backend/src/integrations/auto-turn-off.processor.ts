import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { decrypt } from '../common/crypto.util';
import {
  DIDI_BASE,
  fetchShopIdMap,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

type StockEndpoint = 'setStock' | 'setstockSync';

interface FailedItem {
  appItemId: string;
  reason: string;
}

interface ShopResult {
  shopId: string;
  appShopId: string;
  success: boolean;
  endpoint: StockEndpoint;
  itemsSucceeded: number;
  itemsFailed: number;
  taskId?: string;
  failedItems?: FailedItem[];
  error?: string;
}

@Injectable()
@Processor('auto-turn-off', { concurrency: 1 })
export class AutoTurnOffProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoTurnOffProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhookSenderService,
  ) {
    super();
  }

  async process(job: Job<{ executionId: string }>): Promise<void> {
    const { executionId } = job.data;
    await this.prisma.autoTurnOffExecution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt: new Date(), finishedAt: null },
    });

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

    if (!execution) {
      this.logger.error(`Auto turn off execution ${executionId} not found`);
      return;
    }

    const { rule, pool } = execution;
    const results: ShopResult[] = [];
    const executionStartedAt = new Date();
    const nextAfterCooldown = rule.stockEndpoint === 'setStock'
      ? this.nextOccurrence(rule.startsAt, rule.intervalMinutes, new Date(executionStartedAt.getTime() + 10 * 60_000))
      : rule.nextRunAt;
    await this.prisma.autoTurnOffRule.update({
      where: { id: rule.id },
      data: {
        lastRunAt: executionStartedAt,
        nextRunAt: execution.trigger === 'manual'
          && rule.stockEndpoint === 'setStock'
          && rule.nextRunAt < nextAfterCooldown
          ? nextAfterCooldown
          : undefined,
      },
    });

    if (!rule.brand.application) {
      await this.finish(executionId, 'failed', rule.shopIds.length, 0, 0, [{
        shopId: '-', appShopId: '-', endpoint: rule.stockEndpoint as StockEndpoint,
        success: false, itemsSucceeded: 0, itemsFailed: rule.upcs.length,
        error: 'Brand has no application linked',
      }]);
      await this.notify(pool.webhookId, pool.name, rule.name, rule.brand.brandName, rule.shopIds.length, 0, 0, false);
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
      const message = 'Application credential could not be decrypted with APP_SECRET_ENCRYPTION_KEY';
      const failedResults = rule.shopIds.map(shopId => ({
        shopId,
        appShopId: '-',
        endpoint: rule.stockEndpoint as StockEndpoint,
        success: false,
        itemsSucceeded: 0,
        itemsFailed: rule.upcs.length,
        error: message,
      }));
      this.logger.error(`${message} for brand ${rule.brand.brandName}`);
      await this.finish(executionId, 'failed', rule.shopIds.length, 0, 0, failedResults);
      await this.notify(pool.webhookId, pool.name, rule.name, rule.brand.brandName, rule.shopIds.length, 0, 0, false);
      return;
    }
    const stockList = rule.upcs.map(appItemId => ({ app_item_id: appItemId, stock: 0 }));
    const endpoint = rule.stockEndpoint as StockEndpoint;
    const cachedMappings = rule.resolvedShopIds
      && typeof rule.resolvedShopIds === 'object'
      && !Array.isArray(rule.resolvedShopIds)
      ? Object.entries(rule.resolvedShopIds).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      : [];
    const shopIdMap = new Map<string, string>(cachedMappings);
    const unresolvedShopIds = rule.shopIds.filter(shopId => !shopIdMap.has(shopId));

    if (unresolvedShopIds.length > 0) {
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
        const fetchError = error as Error & { cause?: { code?: string; message?: string } };
        const detail = fetchError.cause?.code ?? fetchError.cause?.message ?? fetchError.message;
        const message = `Could not resolve shop_id values from DiDi: ${detail}`;
        const failedResults = rule.shopIds.map(shopId => ({
          shopId,
          appShopId: '-',
          endpoint,
          success: false,
          itemsSucceeded: 0,
          itemsFailed: rule.upcs.length,
          error: message,
        }));
        await this.finish(executionId, 'failed', rule.shopIds.length, 0, 0, failedResults);
        await this.notify(pool.webhookId, pool.name, rule.name, rule.brand.brandName, rule.shopIds.length, 0, 0, false);
        return;
      }
    }

    for (const shopId of rule.shopIds) {
      const appShopId = shopIdMap.get(shopId);
      if (!appShopId) {
        results.push({
          shopId,
          appShopId: '-',
          endpoint,
          success: false,
          itemsSucceeded: 0,
          itemsFailed: rule.upcs.length,
          error: 'shop_id was not found in the DiDi shop list for this application',
        });
        continue;
      }

      try {
        const authToken = await getAuthToken(appId, appSecret, appShopId);
        const result = await this.callStockApi(endpoint, authToken, stockList);
        results.push({ shopId, appShopId, endpoint, ...result });
        this.logger.log(
          `${endpoint}: turned off ${result.itemsSucceeded}/${rule.upcs.length} items in shop ${shopId} (${rule.name})`,
        );
      } catch (error) {
        results.push({
          shopId,
          appShopId,
          endpoint,
          success: false,
          itemsSucceeded: 0,
          itemsFailed: rule.upcs.length,
          error: (error as Error).message,
        });
        this.logger.error(`Auto turn off failed for shop ${shopId}: ${(error as Error).message}`);
      }
    }

    const shopsSucceeded = results.filter(result => result.success).length;
    const itemsTurnedOff = results.reduce((total, result) => total + result.itemsSucceeded, 0);
    const succeeded = shopsSucceeded === rule.shopIds.length
      && itemsTurnedOff === rule.shopIds.length * rule.upcs.length;
    const status = itemsTurnedOff > 0 ? 'done' : 'failed';
    await this.finish(executionId, status, rule.shopIds.length, shopsSucceeded, itemsTurnedOff, results);
    await this.notify(
      pool.webhookId,
      pool.name,
      rule.name,
      rule.brand.brandName,
      rule.shopIds.length,
      shopsSucceeded,
      itemsTurnedOff,
      succeeded,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    const executionId = job?.data?.executionId;
    if (!executionId) return;
    this.logger.error(`Auto turn off execution ${executionId} failed unexpectedly: ${error.message}`);
    await this.prisma.autoTurnOffExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        logs: { error: error.message } as Prisma.InputJsonValue,
      },
    });
  }

  private async finish(
    executionId: string,
    status: 'done' | 'failed',
    totalShops: number,
    shopsSucceeded: number,
    itemsTurnedOff: number,
    results: ShopResult[],
  ) {
    await this.prisma.autoTurnOffExecution.update({
      where: { id: executionId },
      data: {
        status,
        finishedAt: new Date(),
        totalShops,
        shopsSucceeded,
        itemsTurnedOff,
        logs: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async notify(
    webhookId: string | null,
    poolName: string,
    ruleName: string,
    brandName: string,
    totalShops: number,
    shopsSucceeded: number,
    itemsTurnedOff: number,
    complete: boolean,
  ) {
    if (!webhookId) return;
    await this.webhooks.sendToWebhook(webhookId, {
      text: `**Auto Turn Off Items — ${poolName}**`,
      attachments: [{
        title: ruleName,
        text: [
          `**Brand:** ${brandName}`,
          `**Shops:** ${shopsSucceeded}/${totalShops}`,
          `**UPCs set to stock 0:** ${itemsTurnedOff}`,
        ].join('\n'),
        color: complete ? '#00C853' : (shopsSucceeded > 0 ? '#FFB300' : '#D50000'),
      }],
    });
  }

  private async callStockApi(
    endpoint: StockEndpoint,
    authToken: string,
    stockList: Array<{ app_item_id: string; stock: number }>,
  ): Promise<Omit<ShopResult, 'shopId' | 'appShopId' | 'endpoint'>> {
    const response = await fetch(`${DIDI_BASE}/v1/item/item/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, stock_list: stockList }),
    });
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(
        `DiDi error${body.errno !== undefined ? ` (errno=${body.errno})` : ''}: `
        + (body.errmsg || body.message || `HTTP ${response.status}`),
      );
    }

    if (endpoint === 'setStock') {
      const taskId = body.data?.taskID ?? body.data?.taskId ?? body.taskID;
      return {
        success: true,
        itemsSucceeded: stockList.length,
        itemsFailed: 0,
        taskId: taskId ? String(taskId) : undefined,
      };
    }

    const successfulItems = Array.isArray(body.data?.success)
      ? body.data.success.map((item: unknown) => String(item))
      : [];
    const failedItems: FailedItem[] = Array.isArray(body.data?.failed)
      ? body.data.failed.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const failure = item as Record<string, unknown>;
        const explicitItemId = failure.ext_id ?? failure.app_item_id;
        if (explicitItemId !== undefined) {
          return [{
            appItemId: String(explicitItemId),
            reason: String(failure.msg ?? failure.reason ?? 'Failed'),
          }];
        }
        return Object.entries(failure).map(([appItemId, reason]) => ({
          appItemId,
          reason: String(reason),
        }));
      })
      : [];

    if (successfulItems.length === 0 && failedItems.length === 0 && stockList.length > 0) {
      throw new Error('setstockSync returned no success or failed item details');
    }

    return {
      success: failedItems.length === 0 && successfulItems.length === stockList.length,
      itemsSucceeded: successfulItems.length,
      itemsFailed: failedItems.length,
      failedItems: failedItems.length > 0 ? failedItems : undefined,
      error: failedItems.length > 0
        ? `${failedItems.length} item(s) failed: ${failedItems.slice(0, 5).map(item => `${item.appItemId}: ${item.reason}`).join('; ')}`
        : undefined,
    };
  }

  private nextOccurrence(startsAt: Date, intervalMinutes: number, after: Date) {
    if (startsAt.getTime() >= after.getTime()) return startsAt;
    const intervalMs = intervalMinutes * 60_000;
    const elapsed = after.getTime() - startsAt.getTime();
    return new Date(startsAt.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
  }
}
