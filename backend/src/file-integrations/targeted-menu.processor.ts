import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { downloadMenu } from '../integrations/auto-turn-off-api.util';
import {
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  isRawShopId,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';
import { selectMenuUpcBatches, selectMenuUpcs } from './targeted-menu.util';

class TargetedMenuCancelledError extends Error {}

interface ShopUploadResult {
  shopId: string;
  appShopId?: string;
  status: 'done' | 'partial_success' | 'failed';
  requestedUpcs: number;
  uploadedUpcs: number;
  missingUpcs: string[];
  exportTaskId?: string;
  uploadTaskId?: string;
  uploadTaskIds?: string[];
  error?: string;
}

@Injectable()
@Processor('targeted-menu', { concurrency: 3 })
export class TargetedMenuProcessor extends WorkerHost {
  private readonly logger = new Logger(TargetedMenuProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.prisma.targetedMenuExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), errorMessage: null },
    });
    if (!claimed.count) return;

    const execution = await this.prisma.targetedMenuExecution.findUnique({
      where: { id: executionId },
      include: { rule: { include: { brand: { include: { application: true } } } } },
    });
    if (!execution) return;
    const { rule } = execution;
    const application = rule.brand.application;
    if (!application) {
      await this.fail(executionId, 'The selected brand has no DiDi application linked', []);
      return;
    }
    const results: ShopUploadResult[] = [];
    try {
      const encryptionKey = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      let appSecret: string;
      try {
        appSecret = decrypt(application.appSecret, encryptionKey);
      } catch {
        throw new Error(`Credential for application ${application.appName} could not be decrypted with APP_SECRET_ENCRYPTION_KEY`);
      }
      const targets = await this.resolveTargets(rule.brandId, rule.shopIds, application.appId, appSecret);
      for (const target of targets) {
        await this.ensureActive(executionId);
        await this.prisma.targetedMenuExecution.update({
          where: { id: executionId }, data: { currentShopId: target.shopId },
        });
        if (!target.appShopId) {
          results.push({
            shopId: target.shopId,
            status: 'failed',
            requestedUpcs: rule.upcs.length,
            uploadedUpcs: 0,
            missingUpcs: rule.upcs,
            error: 'shop_id was not found locally or in POST /v1/shop/shop/list',
          });
          await this.progress(executionId, results);
          continue;
        }
        try {
          const authToken = await getAuthToken(application.appId, appSecret, target.appShopId);
          const downloaded = await downloadMenu(authToken, () => this.ensureActive(executionId));
          const sourceMenu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
          const uploadTaskIds: string[] = [];
          const foundUpcs = new Set<string>();
          const missingUpcs = new Set<string>();
          for (const selected of selectMenuUpcBatches(sourceMenu, rule.upcs)) {
            await this.ensureActive(executionId);
            selected.foundUpcs.forEach(upc => foundUpcs.add(upc));
            selected.missingUpcs.forEach(upc => missingUpcs.add(upc));
            if (!selected.items.length) continue;
            if (selected.categories.length > 30) {
              throw new Error(`Selected UPCs require ${selected.categories.length} categories; DiDi accepts a maximum of 30 per upload`);
            }
            uploadTaskIds.push(await this.upload(authToken, selected));
          }
          if (!uploadTaskIds.length) {
            throw new Error(`None of the ${rule.upcs.length} requested UPCs exist in the downloaded menu`);
          }
          results.push({
            shopId: target.shopId,
            appShopId: target.appShopId,
            status: missingUpcs.size ? 'partial_success' : 'done',
            requestedUpcs: rule.upcs.length,
            uploadedUpcs: foundUpcs.size,
            missingUpcs: [...missingUpcs],
            exportTaskId: downloaded.taskId,
            uploadTaskId: uploadTaskIds.join(', '),
            uploadTaskIds,
          });
        } catch (error) {
          results.push({
            shopId: target.shopId,
            appShopId: target.appShopId,
            status: 'failed',
            requestedUpcs: rule.upcs.length,
            uploadedUpcs: 0,
            missingUpcs: rule.upcs,
            error: (error as Error).message,
          });
        }
        await this.progress(executionId, results);
      }

      await this.ensureActive(executionId);
      const successfulShops = results.filter(result => result.status !== 'failed').length;
      const failedShops = results.length - successfulShops;
      const hasMissingUpcs = results.some(result => result.missingUpcs.length > 0);
      const status: AutoOpenStatus = successfulShops === 0
        ? AutoOpenStatus.failed
        : failedShops > 0 || hasMissingUpcs
          ? AutoOpenStatus.partial_success
          : AutoOpenStatus.done;
      const errorMessage = status === AutoOpenStatus.done
        ? null
        : `${failedShops} store(s) failed; ${results.reduce((sum, result) => sum + result.missingUpcs.length, 0)} UPC match(es) missing`;
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.targetedMenuExecution.update({
          where: { id: executionId },
          data: {
            status,
            finishedAt: now,
            currentShopId: null,
            processedShops: results.length,
            successfulShops,
            failedShops,
            errorMessage,
            result: { shops: results } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.targetedMenuRule.update({ where: { id: rule.id }, data: { lastRunAt: now } }),
      ]);
      this.logger.log(`Targeted menu rule ${rule.name}: ${status}, ${successfulShops}/${results.length} stores accepted`);
    } catch (error) {
      if (error instanceof TargetedMenuCancelledError) return;
      await this.fail(executionId, (error as Error).message, results);
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    this.logger.error(`Targeted menu job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  }

  private async resolveTargets(brandId: string, requested: string[], appId: string, appSecret: string) {
    const local = await this.prisma.shop.findMany({
      where: {
        brandId,
        deletedAt: null,
        OR: [{ shopId: { in: requested } }, { appShopId: { in: requested } }],
      },
      select: { shopId: true, appShopId: true },
    });
    const localByShopId = new Map(local.map(shop => [shop.shopId, shop.appShopId]));
    const localByAppShopId = new Map(local.map(shop => [shop.appShopId, shop.appShopId]));
    const unresolvedRawIds = requested.filter(value => isRawShopId(value) && !localByShopId.has(value));
    const remote = unresolvedRawIds.length
      ? await fetchShopIdMap(appId, appSecret, unresolvedRawIds)
      : new Map<string, string>();
    return requested.map(shopId => ({
      shopId,
      appShopId: localByShopId.get(shopId)
        ?? localByAppShopId.get(shopId)
        ?? (isRawShopId(shopId) ? remote.get(shopId) : shopId),
    }));
  }

  private async upload(authToken: string, selected: ReturnType<typeof selectMenuUpcs>) {
    const endpoint = 'POST /v3/item/item/uploadGrocery';
    const payload: Record<string, unknown> = {
      auth_token: authToken,
      menus: selected.menus,
      categories: selected.categories,
      items: selected.items,
      merge_policy: 0,
    };
    if (selected.modifierGroups.length) payload.modifier_groups = selected.modifierGroups;
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v3/item/item/uploadGrocery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
    return String(body.data?.taskID ?? body.data?.taskId ?? 'accepted');
  }

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.targetedMenuExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.cancelRequested || execution.status === 'cancelled') {
      throw new TargetedMenuCancelledError('Execution cancelled');
    }
  }

  private async progress(executionId: string, results: ShopUploadResult[]) {
    await this.prisma.targetedMenuExecution.update({
      where: { id: executionId },
      data: {
        processedShops: results.length,
        successfulShops: results.filter(result => result.status !== 'failed').length,
        failedShops: results.filter(result => result.status === 'failed').length,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async fail(executionId: string, message: string, results: ShopUploadResult[]) {
    await this.prisma.targetedMenuExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        currentShopId: null,
        processedShops: results.length,
        successfulShops: results.filter(result => result.status !== 'failed').length,
        failedShops: results.filter(result => result.status === 'failed').length,
        errorMessage: message,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
