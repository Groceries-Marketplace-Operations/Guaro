import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { downloadMenu, MenuDownloadProgress } from '../integrations/auto-turn-off-api.util';
import {
  fetchShopIdMap,
  getAuthToken,
  isRawShopId,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';
import { buildFlatGroceryUploads, groceryMergePolicyForBatch } from './grocery-destination-menu.util';
import {
  GroceryBatchUploadResult,
  GroceryItemFailure,
  resolveGroceryBatchSubmission,
  submitGroceryBatch,
} from './grocery-menu-upload.util';
import { selectMenuUpcs } from './targeted-menu.util';

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
  failedItems?: GroceryItemFailure[];
  error?: string;
}

interface TargetedUploadBatchProgress {
  referenceId: string;
  itemCount: number;
  status: 'submitted' | 'done';
  acceptedCount?: number;
  failedItems?: GroceryItemFailure[];
}

interface TargetedMenuProgress {
  shopId: string;
  phase: 'resolving_shop' | 'downloading_menu' | 'matching_upcs' | 'submitting_menu' | 'confirming_upload';
  message: string;
  exportTaskId?: string;
  exportPollAttempts?: number;
  exportStatus?: number;
  currentBatch?: number;
  totalBatches?: number;
  uploadBatches?: TargetedUploadBatchProgress[];
}

interface TargetedMenuExecutionResult {
  shops?: ShopUploadResult[];
  progress?: TargetedMenuProgress;
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
    const existingExecution = await this.prisma.targetedMenuExecution.findUnique({
      where: { id: executionId }, select: { startedAt: true },
    });
    const claimed = await this.prisma.targetedMenuExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: existingExecution?.startedAt ?? new Date(), errorMessage: null },
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
    const savedState = (execution.result ?? {}) as unknown as TargetedMenuExecutionResult;
    const results: ShopUploadResult[] = [...(savedState.shops ?? [])];
    let activeProgress = savedState.progress;
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
        if (results.some(result => result.shopId === target.shopId)) continue;
        await this.ensureActive(executionId);
        activeProgress = activeProgress?.shopId === target.shopId
          ? activeProgress
          : {
            shopId: target.shopId,
            phase: 'resolving_shop',
            message: 'Resolving shop credentials',
          };
        await this.prisma.targetedMenuExecution.update({
          where: { id: executionId },
          data: {
            currentShopId: target.shopId,
            result: { shops: results, progress: activeProgress } as unknown as Prisma.InputJsonValue,
          },
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
          activeProgress = undefined;
          await this.progress(executionId, results);
          continue;
        }
        try {
          const authToken = await getAuthToken(application.appId, appSecret, target.appShopId);
          activeProgress = {
            ...activeProgress,
            shopId: target.shopId,
            phase: 'downloading_menu',
            message: activeProgress?.exportTaskId ? 'Resuming menu export' : 'Requesting the store menu export',
          };
          await this.progress(executionId, results, activeProgress);
          const downloaded = await downloadMenu(
            authToken,
            () => this.ensureActive(executionId),
            () => getAuthToken(application.appId, appSecret, target.appShopId!),
            {
              existingTaskId: activeProgress.exportTaskId,
              onProgress: async (downloadProgress: MenuDownloadProgress) => {
                activeProgress = {
                  ...activeProgress!,
                  phase: 'downloading_menu',
                  message: downloadProgress.phase === 'downloading'
                    ? 'Downloading the exported menu'
                    : downloadProgress.rateLimited
                      ? 'Waiting for the shared DiDi task-status window'
                      : 'Waiting for DiDi to prepare the menu export',
                  exportTaskId: downloadProgress.taskId,
                  exportPollAttempts: downloadProgress.pollAttempts,
                  exportStatus: downloadProgress.status,
                };
                await this.progress(executionId, results, activeProgress);
              },
            },
          );
          const sourceMenu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
          activeProgress = {
            ...activeProgress,
            phase: 'matching_upcs',
            message: `Matching ${rule.upcs.length} requested UPCs against the exported menu`,
            exportTaskId: downloaded.taskId,
          };
          await this.progress(executionId, results, activeProgress);
          const uploadTaskIds: string[] = [];
          const failedItems: GroceryItemFailure[] = [];
          let acceptedCount = 0;
          const selected = selectMenuUpcs(sourceMenu, rule.upcs);
          if (!selected.items.length) {
            throw new Error(`None of the ${rule.upcs.length} requested UPCs exist in the downloaded menu`);
          }
          const uploads = buildFlatGroceryUploads(sourceMenu, selected.items);
          const savedBatches = activeProgress.uploadBatches ?? [];
          for (let index = 0; index < uploads.length; index++) {
            await this.ensureActive(executionId);
            const mergePolicy = groceryMergePolicyForBatch(rule.mergePolicy, index);
            let batchProgress = savedBatches[index];
            let upload: GroceryBatchUploadResult;
            if (batchProgress?.status === 'done') {
              upload = {
                referenceId: batchProgress.referenceId,
                successfulItemIds: [],
                failedItems: batchProgress.failedItems ?? [],
                acceptedCount: batchProgress.acceptedCount ?? 0,
              };
            } else {
              if (!batchProgress) {
                activeProgress = {
                  ...activeProgress,
                  phase: 'submitting_menu',
                  message: `Submitting menu batch ${index + 1} of ${uploads.length}`,
                  currentBatch: index + 1,
                  totalBatches: uploads.length,
                  uploadBatches: savedBatches,
                };
                await this.progress(executionId, results, activeProgress);
                const submission = await submitGroceryBatch(authToken, uploads[index], rule.uploadEndpoint, mergePolicy);
                if ('acceptedCount' in submission) {
                  upload = submission;
                  batchProgress = {
                    referenceId: submission.referenceId,
                    itemCount: uploads[index].items.length,
                    status: 'done',
                    acceptedCount: submission.acceptedCount,
                    failedItems: submission.failedItems,
                  };
                } else {
                  batchProgress = {
                    referenceId: submission.referenceId,
                    itemCount: uploads[index].items.length,
                    status: 'submitted',
                  };
                  savedBatches[index] = batchProgress;
                  activeProgress = {
                    ...activeProgress,
                    phase: 'confirming_upload',
                    message: `Waiting for DiDi confirmation for batch ${index + 1} of ${uploads.length}`,
                    currentBatch: index + 1,
                    totalBatches: uploads.length,
                    uploadBatches: savedBatches,
                  };
                  await this.progress(executionId, results, activeProgress);
                  upload = await resolveGroceryBatchSubmission(
                    authToken,
                    submission.referenceId,
                    uploads[index].items.length,
                    () => this.ensureActive(executionId),
                    () => getAuthToken(application.appId, appSecret, target.appShopId!),
                  );
                }
              } else {
                activeProgress = {
                  ...activeProgress,
                  phase: 'confirming_upload',
                  message: `Resuming DiDi confirmation for batch ${index + 1} of ${uploads.length}`,
                  currentBatch: index + 1,
                  totalBatches: uploads.length,
                  uploadBatches: savedBatches,
                };
                await this.progress(executionId, results, activeProgress);
                upload = await resolveGroceryBatchSubmission(
                  authToken,
                  batchProgress.referenceId,
                  uploads[index].items.length,
                  () => this.ensureActive(executionId),
                  () => getAuthToken(application.appId, appSecret, target.appShopId!),
                );
              }
              batchProgress = {
                referenceId: upload.referenceId,
                itemCount: uploads[index].items.length,
                status: 'done',
                acceptedCount: upload.acceptedCount,
                failedItems: upload.failedItems,
              };
              savedBatches[index] = batchProgress;
              activeProgress = { ...activeProgress!, uploadBatches: savedBatches };
              await this.progress(executionId, results, activeProgress);
            }
            uploadTaskIds.push(upload.referenceId);
            failedItems.push(...upload.failedItems);
            acceptedCount += upload.acceptedCount;
          }
          const uploadFailed = acceptedCount === 0;
          results.push({
            shopId: target.shopId,
            appShopId: target.appShopId,
            status: uploadFailed ? 'failed' : selected.missingUpcs.length || failedItems.length ? 'partial_success' : 'done',
            requestedUpcs: rule.upcs.length,
            uploadedUpcs: Math.min(selected.foundUpcs.length, acceptedCount),
            missingUpcs: selected.missingUpcs,
            exportTaskId: downloaded.taskId,
            uploadTaskId: uploadTaskIds.join(', '),
            uploadTaskIds,
            failedItems,
            error: uploadFailed ? `${failedItems.length} item update(s) failed` : undefined,
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
        activeProgress = undefined;
        await this.progress(executionId, results);
      }

      await this.ensureActive(executionId);
      const successfulShops = results.filter(result => result.status !== 'failed').length;
      const failedShops = results.length - successfulShops;
      const hasMissingUpcs = results.some(result => result.missingUpcs.length > 0);
      const failedItemUpdates = results.reduce((sum, result) => sum + (result.failedItems?.length ?? 0), 0);
      const status: AutoOpenStatus = successfulShops === 0
        ? AutoOpenStatus.failed
        : failedShops > 0 || hasMissingUpcs || failedItemUpdates > 0
          ? AutoOpenStatus.partial_success
          : AutoOpenStatus.done;
      const errorMessage = status === AutoOpenStatus.done
        ? null
        : `${failedShops} store(s) failed; ${results.reduce((sum, result) => sum + result.missingUpcs.length, 0)} UPC match(es) missing; ${failedItemUpdates} item update(s) failed`;
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

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.targetedMenuExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.cancelRequested || execution.status === 'cancelled') {
      throw new TargetedMenuCancelledError('Execution cancelled');
    }
  }

  private async progress(
    executionId: string,
    results: ShopUploadResult[],
    progress?: TargetedMenuProgress,
  ) {
    await this.prisma.targetedMenuExecution.update({
      where: { id: executionId },
      data: {
        processedShops: results.length,
        successfulShops: results.filter(result => result.status !== 'failed').length,
        failedShops: results.filter(result => result.status === 'failed').length,
        result: { shops: results, ...(progress ? { progress } : {}) } as unknown as Prisma.InputJsonValue,
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
