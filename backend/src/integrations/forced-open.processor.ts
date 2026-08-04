import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

@Injectable()
@Processor('forced-open', { concurrency: 3 })
export class ForcedOpenProcessor extends WorkerHost {
  private readonly logger = new Logger(ForcedOpenProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) { super(); }

  async process(job: Job<{ operationId: string }>) {
    const { operationId } = job.data;
    const claimed = await this.prisma.forcedOpenOperation.updateMany({
      where: { id: operationId, status: { in: ['pending', 'running'] } },
      data: { status: 'running', startedAt: new Date(), errorMessage: null },
    });
    if (claimed.count === 0) return;
    const operation = await this.prisma.forcedOpenOperation.findUnique({
      where: { id: operationId },
      include: {
        brand: { include: { application: { select: { appId: true, appSecret: true } } } },
        targets: {
          where: { status: { not: 'done' } },
          include: { shop: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!operation) return;
    const application = operation.brand.application;
    if (!application) return this.fail(operationId, 'Brand has no linked application credentials');

    let appSecret: string;
    try {
      const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
      appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
    } catch {
      return this.fail(operationId, 'Application credential could not be decrypted');
    }

    let cursor = 0;
    const workers = Math.min(3, Math.max(1, operation.targets.length));
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= operation.targets.length) return;
        const target = operation.targets[index];
        await this.processTarget(target.id, target.shop.appShopId, application.appId, appSecret);
      }
    };
    await Promise.all(Array.from({ length: workers }, () => worker()));
    await this.finalize(operationId);
  }

  private async processTarget(targetId: string, appShopId: string, appId: string, appSecret: string) {
    await this.prisma.forcedOpenTarget.update({ where: { id: targetId }, data: { status: 'running', error: null } });
    try {
      const authToken = await getAuthToken(appId, appSecret, appShopId);
      const endpoint = 'POST /v1/shop/shop/setStatus';
      const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: authToken, biz_status: 1, auto_switch: 1 }),
      });
      const body = parseJsonKeepingIds(await response.text());
      if (!response.ok || body.errno !== 0) {
        throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
      }
      await this.prisma.forcedOpenTarget.update({
        where: { id: targetId },
        data: { status: 'done', openedAt: new Date() },
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Forced open failed for app_shop_id ${appShopId}: ${message}`);
      await this.prisma.forcedOpenTarget.update({ where: { id: targetId }, data: { status: 'failed', error: message } });
    }
  }

  private async finalize(operationId: string) {
    const targets = await this.prisma.forcedOpenTarget.findMany({ where: { operationId }, select: { status: true } });
    const opened = targets.filter(target => target.status === 'done').length;
    const failed = targets.length - opened;
    await this.prisma.forcedOpenOperation.update({
      where: { id: operationId },
      data: {
        status: opened === targets.length ? 'done' : opened > 0 ? 'partial_success' : 'failed',
        shopsOpened: opened,
        shopsFailed: failed,
        errorMessage: failed > 0 ? `${failed} of ${targets.length} store(s) could not be opened` : null,
        finishedAt: new Date(),
      },
    });
  }

  private async fail(operationId: string, message: string) {
    await this.prisma.forcedOpenOperation.updateMany({
      where: { id: operationId },
      data: { status: 'failed', errorMessage: message, finishedAt: new Date() },
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ operationId: string }> | undefined, error: Error) {
    if (job) await this.fail(job.data.operationId, error.message);
  }
}
