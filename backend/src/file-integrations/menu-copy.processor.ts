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
import { buildFlatGroceryUploads, groceryMergePolicyForBatch } from './grocery-destination-menu.util';
import { GroceryItemFailure, uploadGroceryBatch } from './grocery-menu-upload.util';

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
      const downloaded = await downloadMenu(sourceToken, () => this.ensureActive(executionId));
      const menu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
      const items = Array.isArray(menu.items) ? menu.items : [];
      if (!items.length) throw new Error('The source menu contains no items');
      const uploads = buildFlatGroceryUploads(menu, items as Record<string, unknown>[]);

      await this.step(executionId, 'uploading_target_menu', {
        exportTaskId: downloaded.taskId,
        itemCount: items.length,
        categoryCount: uploads.length,
      });
      const targetToken = await getAuthToken(targetApplication.appId, targetSecret, targetAppShopId);
      const uploadTaskIds: string[] = [];
      const failedItems: GroceryItemFailure[] = [];
      let acceptedCount = 0;
      for (let index = 0; index < uploads.length; index++) {
        await this.ensureActive(executionId);
        const mergePolicy = groceryMergePolicyForBatch(execution.mergePolicy, index);
        const upload = await uploadGroceryBatch(targetToken, uploads[index], execution.uploadEndpoint, mergePolicy);
        uploadTaskIds.push(upload.referenceId);
        failedItems.push(...upload.failedItems);
        acceptedCount += upload.acceptedCount;
      }
      const uploadTaskId = uploadTaskIds.join(', ');
      await this.ensureActive(executionId);
      const status = acceptedCount === 0 ? 'failed' : failedItems.length ? 'partial_success' : 'done';
      const errorMessage = failedItems.length
        ? `${failedItems.length} item update(s) failed: ${failedItems.slice(0, 10).map(item => `${item.appItemId}: ${item.reason}`).join('; ')}`
        : null;
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
        `Copied ${acceptedCount}/${items.length} items from ${execution.sourceShopId} (${sourceApplication.appName}) `
        + `to ${execution.targetShopId} (${targetApplication.appName}) using ${execution.uploadEndpoint}; upload reference=${uploadTaskId}`,
      );
    } catch (error) {
      if (error instanceof MenuCopyCancelledError) return;
      await this.prisma.menuCopyExecution.updateMany({
        where: { id: executionId, status: { in: ['pending', 'running'] } },
        data: {
          status: 'failed',
          currentStep: null,
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
