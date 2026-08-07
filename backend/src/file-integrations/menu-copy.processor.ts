import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { downloadMenu } from '../integrations/auto-turn-off-api.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';
import { buildFlatGroceryUploads, FlatGroceryUpload, groceryMergePolicyForBatch } from './grocery-destination-menu.util';

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
      for (let index = 0; index < uploads.length; index++) {
        await this.ensureActive(executionId);
        const mergePolicy = groceryMergePolicyForBatch(execution.mergePolicy, index);
        uploadTaskIds.push(await this.upload(targetToken, uploads[index], mergePolicy));
      }
      const uploadTaskId = uploadTaskIds.join(', ');
      await this.ensureActive(executionId);
      await this.prisma.menuCopyExecution.update({
        where: { id: executionId },
        data: {
          status: 'done',
          currentStep: 'completed',
          uploadTaskId,
          finishedAt: new Date(),
          errorMessage: null,
        },
      });
      this.logger.log(
        `Copied ${items.length} items from ${execution.sourceShopId} (${sourceApplication.appName}) `
        + `to ${execution.targetShopId} (${targetApplication.appName}); upload task=${uploadTaskId}`,
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

  private async upload(authToken: string, menu: FlatGroceryUpload, mergePolicy: number) {
    const endpoint = 'POST /v3/item/item/uploadGrocery';
    const payload: Record<string, unknown> = {
      auth_token: authToken,
      menus: menu.menus,
      categories: menu.categories,
      items: menu.items,
      merge_policy: mergePolicy,
    };
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
