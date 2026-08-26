import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  fetchShopIdMap,
  getAuthToken,
  sleep,
} from '../queue/handlers/didi-food.util';
import { updatePromiseProduceTime } from './massive-rtbo.util';

class MassiveRtboCancelledError extends Error {}

interface MassiveRtboShopResult {
  shopId: string;
  appShopId?: string;
  status: 'done' | 'failed';
  error?: string;
}

@Injectable()
@Processor('massive-rtbo', { concurrency: 1 })
export class MassiveRtboProcessor extends WorkerHost {
  private readonly logger = new Logger(MassiveRtboProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.prisma.massiveRtboExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: {
        status: 'running',
        startedAt: new Date(),
        currentStep: 'resolving_shops',
        errorMessage: null,
      },
    });
    if (!claimed.count) return;

    const execution = await this.prisma.massiveRtboExecution.findUnique({
      where: { id: executionId },
      include: { application: true },
    });
    if (!execution) return;

    const results: MassiveRtboShopResult[] = [];
    try {
      const encryptionKey = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      let appSecret: string;
      try {
        appSecret = decrypt(execution.application.appSecret, encryptionKey);
      } catch {
        throw new Error(`Credential for application ${execution.application.appName} could not be decrypted with APP_SECRET_ENCRYPTION_KEY`);
      }

      await this.ensureActive(executionId);
      const shopMap = await fetchShopIdMap(
        execution.application.appId,
        appSecret,
        execution.shopIds.length ? execution.shopIds : undefined,
      );
      const requestedIds = execution.shopIds.length
        ? execution.shopIds
        : [...shopMap.keys()].sort();
      const targets = requestedIds.flatMap(shopId => {
        const appShopId = shopMap.get(shopId);
        return appShopId ? [{ shopId, appShopId }] : [];
      });
      for (const shopId of requestedIds.filter(value => !shopMap.has(value))) {
        results.push({
          shopId,
          status: 'failed',
          error: 'shop_id was not found in POST /v1/shop/shop/list',
        });
      }
      await this.prisma.massiveRtboExecution.update({
        where: { id: executionId },
        data: {
          totalShops: requestedIds.length,
          currentStep: 'updating_shops',
          result: { shops: results } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.progress(executionId, results);
      if (!requestedIds.length) throw new Error('The selected application has no shops');

      for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
        for (const target of targets.slice(offset, offset + BATCH_SIZE)) {
          await this.ensureActive(executionId);
          await this.prisma.massiveRtboExecution.update({
            where: { id: executionId },
            data: { currentShopId: target.shopId },
          });
          try {
            const authToken = await getAuthToken(
              execution.application.appId,
              appSecret,
              target.appShopId,
            );
            await updatePromiseProduceTime(authToken, execution.promiseProduceTime);
            results.push({ shopId: target.shopId, appShopId: target.appShopId, status: 'done' });
          } catch (error) {
            results.push({
              shopId: target.shopId,
              appShopId: target.appShopId,
              status: 'failed',
              error: (error as Error).message,
            });
          }
          await this.progress(executionId, results);
        }
        if (offset + BATCH_SIZE < targets.length) {
          await this.ensureActive(executionId);
          await sleep(COOLDOWN_BATCH_MS);
        }
      }

      await this.ensureActive(executionId);
      const successfulShops = results.filter(result => result.status === 'done').length;
      const failedShops = results.length - successfulShops;
      const status: AutoOpenStatus = successfulShops === 0
        ? AutoOpenStatus.failed
        : failedShops > 0
          ? AutoOpenStatus.partial_success
          : AutoOpenStatus.done;
      await this.prisma.massiveRtboExecution.update({
        where: { id: executionId },
        data: {
          status,
          finishedAt: new Date(),
          currentShopId: null,
          currentStep: 'completed',
          processedShops: results.length,
          successfulShops,
          failedShops,
          errorMessage: failedShops ? `${failedShops} store(s) failed` : null,
          result: { shops: results } as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.log(
        `Massive RTBO ${executionId}: ${status}, ${successfulShops}/${results.length} shops updated to ${execution.promiseProduceTime}s`,
      );
    } catch (error) {
      if (error instanceof MassiveRtboCancelledError) return;
      await this.fail(executionId, (error as Error).message, results);
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    this.logger.error(`Massive RTBO job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  }

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.massiveRtboExecution.findUnique({
      where: { id: executionId },
      select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.cancelRequested || execution.status === 'cancelled') {
      throw new MassiveRtboCancelledError('Execution cancelled');
    }
  }

  private async progress(executionId: string, results: MassiveRtboShopResult[]) {
    await this.prisma.massiveRtboExecution.update({
      where: { id: executionId },
      data: {
        processedShops: results.length,
        successfulShops: results.filter(result => result.status === 'done').length,
        failedShops: results.filter(result => result.status === 'failed').length,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async fail(executionId: string, message: string, results: MassiveRtboShopResult[]) {
    await this.prisma.massiveRtboExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        currentShopId: null,
        currentStep: null,
        processedShops: results.length,
        successfulShops: results.filter(result => result.status === 'done').length,
        failedShops: results.filter(result => result.status === 'failed').length,
        errorMessage: message,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
