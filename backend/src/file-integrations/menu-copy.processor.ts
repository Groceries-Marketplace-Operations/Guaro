import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { downloadMenu } from '../integrations/auto-turn-off-api.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  fetchShopIdMap,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';
import {
  buildFlatGroceryUploads,
  countMatchingGroceryDestinationItems,
  groceryMergePolicyForBatch,
  isGroceryDestinationItemUploadable,
} from './grocery-destination-menu.util';
import {
  GroceryItemFailure,
  GroceryUploadPendingError,
  uploadGroceryBatch,
} from './grocery-menu-upload.util';

class MenuCopyCancelledError extends Error {}

@Injectable()
@Processor('menu-copy', { concurrency: 2 })
export class MenuCopyProcessor extends WorkerHost {
  private readonly logger = new Logger(MenuCopyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.prisma.menuCopyExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), currentStep: 'resolving_source_shop', errorMessage: null },
    });
    if (!claimed.count) return;

    try {
      const execution = await this.prisma.menuCopyExecution.findUnique({
        where: { id: executionId },
        include: {
          sourceApplication: true,
          targetApplication: true,
        },
      });
      if (!execution) return;
      const sourceApplication = execution.sourceApplication;
      const targetApplication = execution.targetApplication;

      const encryptionKey = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      let sourceSecret: string;
      let targetSecret: string;
      try {
        sourceSecret = decrypt(sourceApplication.appSecret, encryptionKey);
        targetSecret = decrypt(targetApplication.appSecret, encryptionKey);
      } catch {
        throw new Error('Source or target application credential could not be decrypted with APP_SECRET_ENCRYPTION_KEY');
      }

      const sourceAppShopId = await this.resolveAppShopId(
        execution.sourceApplicationId,
        execution.sourceShopId,
        sourceApplication.appId,
        sourceSecret,
      );
      await this.step(executionId, 'resolving_target_shop', { sourceAppShopId });
      const targetAppShopId = await this.resolveAppShopId(
        execution.targetApplicationId,
        execution.targetShopId,
        targetApplication.appId,
        targetSecret,
      );

      await this.step(executionId, 'downloading_source_menu', { targetAppShopId });
      const sourceToken = await getAuthToken(sourceApplication.appId, sourceSecret, sourceAppShopId);
      const downloaded = await downloadMenu(
        sourceToken,
        () => this.ensureActive(executionId),
        () => getAuthToken(sourceApplication.appId, sourceSecret, sourceAppShopId),
      );
      const menu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
      const sourceItems = Array.isArray(menu.items) ? menu.items as Record<string, unknown>[] : [];
      if (!sourceItems.length) throw new Error('The source menu contains no items');
      const items = sourceItems.filter(isGroceryDestinationItemUploadable);
      const skippedItems = sourceItems.length - items.length;
      if (!items.length) throw new Error('The source menu contains no items with both app_item_id and UPC');
      const uploads = buildFlatGroceryUploads(
        menu,
        items,
        undefined,
        execution.uploadEndpoint === 'uploadGrocery',
      );

      await this.step(executionId, 'uploading_target_menu', {
        exportTaskId: downloaded.taskId,
        itemCount: items.length,
        categoryCount: uploads.reduce((total, upload) => total + upload.categoryIds.length, 0),
      });
      const targetToken = await getAuthToken(targetApplication.appId, targetSecret, targetAppShopId);
      const uploadTaskIds: string[] = [];
      const failedItems: GroceryItemFailure[] = [];
      const pendingUploadTaskIds: string[] = [];
      let acceptedCount = 0;
      for (let index = 0; index < uploads.length; index++) {
        await this.ensureActive(executionId);
        const mergePolicy = groceryMergePolicyForBatch(execution.mergePolicy, index);
        try {
          const upload = await uploadGroceryBatch(
            targetToken,
            uploads[index],
            execution.uploadEndpoint,
            mergePolicy,
            () => this.ensureActive(executionId),
            () => getAuthToken(targetApplication.appId, targetSecret, targetAppShopId),
          );
          uploadTaskIds.push(upload.referenceId);
          failedItems.push(...upload.failedItems);
          acceptedCount += upload.acceptedCount;
        } catch (error) {
          if (!(error instanceof GroceryUploadPendingError)) throw error;
          uploadTaskIds.push(error.taskId);
          pendingUploadTaskIds.push(error.taskId);
          failedItems.push(...error.failedItems);
        }
      }
      const uploadTaskId = uploadTaskIds.join(', ');
      await this.ensureActive(executionId);
      let pendingMessage = '';
      if (pendingUploadTaskIds.length) {
        await this.step(executionId, 'verifying_target_menu', { uploadTaskId });
        try {
          const verificationToken = await getAuthToken(targetApplication.appId, targetSecret, targetAppShopId);
          const verified = await downloadMenu(
            verificationToken,
            () => this.ensureActive(executionId),
            () => getAuthToken(targetApplication.appId, targetSecret, targetAppShopId),
          );
          const verifiedMenu = parseJsonKeepingIds(verified.rawJson) as Record<string, unknown>;
          const actualItems = Array.isArray(verifiedMenu.items)
            ? verifiedMenu.items as Record<string, unknown>[]
            : [];
          const expectedItems = uploads.flatMap(upload => upload.items);
          const matchingItems = countMatchingGroceryDestinationItems(expectedItems, actualItems);
          acceptedCount = Math.max(acceptedCount, matchingItems);
          if (matchingItems === expectedItems.length) {
            this.logger.warn(
              `DiDi task(s) ${pendingUploadTaskIds.join(', ')} remained running, but the destination menu was verified successfully`,
            );
          } else {
            pendingMessage = `DiDi accepted task(s) ${pendingUploadTaskIds.join(', ')} and is still processing; ${matchingItems}/${expectedItems.length} destination items are currently verified`;
          }
        } catch (error) {
          pendingMessage = `DiDi accepted task(s) ${pendingUploadTaskIds.join(', ')} and is still processing; destination verification could not finish: ${(error as Error).message}`;
        }
      }
      const pendingUnverified = pendingUploadTaskIds.length > 0 && acceptedCount < items.length;
      const status = acceptedCount === 0 && !pendingUploadTaskIds.length
        ? 'failed'
        : failedItems.length || skippedItems || pendingUnverified ? 'partial_success' : 'done';
      const details = [
        skippedItems ? `${skippedItems} source item(s) skipped because app_item_id or UPC is missing` : '',
        failedItems.length ? `${failedItems.length} item update(s) failed: ${failedItems.slice(0, 10).map(item => `${item.appItemId}: ${item.reason}`).join('; ')}` : '',
        pendingMessage,
      ].filter(Boolean);
      const errorMessage = details.length ? details.join('; ') : null;
      await this.prisma.menuCopyExecution.update({
        where: { id: executionId },
        data: {
          status,
          currentStep: 'completed',
          uploadTaskId,
          finishedAt: new Date(),
          errorMessage,
        },
      });
      this.logger.log(
        `Copied ${acceptedCount}/${items.length} eligible items (${skippedItems} skipped) from ${execution.sourceShopId} (${sourceApplication.appName}) `
        + `to ${execution.targetShopId} (${targetApplication.appName}) using ${execution.uploadEndpoint}; upload reference=${uploadTaskId}`,
      );
    } catch (error) {
      if (error instanceof MenuCopyCancelledError) return;
      await this.prisma.menuCopyExecution.updateMany({
        where: { id: executionId, status: { in: ['pending', 'running'] } },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage: (error as Error).message,
        },
      });
      this.logger.error(`Cross-app menu copy ${executionId} failed: ${(error as Error).message}`);
    }
  }

  private async resolveAppShopId(applicationId: string, shopId: string, appId: string, appSecret: string) {
    const local = await this.prisma.shop.findFirst({
      where: { shopId, deletedAt: null, brand: { applicationId, deletedAt: null } },
      select: { appShopId: true },
    });
    if (local?.appShopId) return local.appShopId;
    const mapping = await fetchShopIdMap(appId, appSecret, [shopId]);
    const appShopId = mapping.get(shopId);
    if (!appShopId) throw new Error(`shop_id ${shopId} was not found in POST /v1/shop/shop/list for the selected application`);
    return appShopId;
  }

  private async step(executionId: string, currentStep: string, data: Record<string, unknown> = {}) {
    await this.ensureActive(executionId);
    await this.prisma.menuCopyExecution.update({ where: { id: executionId }, data: { currentStep, ...data } });
  }

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.menuCopyExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.cancelRequested || execution.status === 'cancelled') {
      throw new MenuCopyCancelledError('Execution cancelled');
    }
  }
}
