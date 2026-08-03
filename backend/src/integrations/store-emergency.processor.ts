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

type EmergencyAction = 'offline' | 'restore';

@Injectable()
@Processor('store-emergency', { concurrency: 3 })
export class StoreEmergencyProcessor extends WorkerHost {
  private readonly logger = new Logger(StoreEmergencyProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) { super(); }

  async process(job: Job<{ emergencyId: string; action: EmergencyAction }>) {
    const { emergencyId, action } = job.data;
    if (action === 'offline') {
      const claimed = await this.prisma.storeEmergency.updateMany({
        where: { id: emergencyId, status: 'pending' },
        data: { status: 'running', startedAt: new Date(), errorMessage: null },
      });
      if (claimed.count === 0) return;
    } else {
      const emergency = await this.prisma.storeEmergency.findUnique({ where: { id: emergencyId }, select: { status: true } });
      if (emergency?.status !== 'restoring') return;
    }

    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      include: {
        brand: { include: { application: { select: { appId: true, appSecret: true } } } },
        targets: { include: { shop: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!emergency) return;
    const application = emergency.brand.application;
    if (!application) {
      await this.failEmergency(emergency.id, action, 'Brand has no linked application credentials');
      return;
    }

    let appSecret: string;
    try {
      const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
      appSecret = encryptionKey ? decrypt(application.appSecret, encryptionKey) : application.appSecret;
    } catch {
      await this.failEmergency(emergency.id, action, 'Application credential could not be decrypted');
      return;
    }

    const targets = emergency.targets.filter(target => action === 'offline'
      ? target.offlineStatus === 'pending'
      : target.offlineStatus === 'done' && target.restoreStatus === 'pending');
    let cursor = 0;
    const workers = Math.min(3, Math.max(1, targets.length));
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) return;
        const target = targets[index];
        await this.processTarget(target.id, target.shop.appShopId, application.appId, appSecret, action);
      }
    };
    await Promise.all(Array.from({ length: workers }, () => worker()));
    await this.finalize(emergency.id, action);
  }

  private async processTarget(
    targetId: string,
    appShopId: string,
    appId: string,
    appSecret: string,
    action: EmergencyAction,
  ) {
    const statusField = action === 'offline' ? 'offlineStatus' : 'restoreStatus';
    const errorField = action === 'offline' ? 'offlineError' : 'restoreError';
    const dateField = action === 'offline' ? 'offlineAt' : 'restoredAt';
    await this.prisma.storeEmergencyTarget.update({
      where: { id: targetId },
      data: { [statusField]: 'running', [errorField]: null },
    });
    try {
      const authToken = await getAuthToken(appId, appSecret, appShopId);
      await this.setStoreStatus(authToken, action === 'offline' ? 2 : 1);
      await this.prisma.storeEmergencyTarget.update({
        where: { id: targetId },
        data: { [statusField]: 'done', [dateField]: new Date() },
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`${action} failed for app_shop_id ${appShopId}: ${message}`);
      await this.prisma.storeEmergencyTarget.update({
        where: { id: targetId },
        data: { [statusField]: 'failed', [errorField]: message },
      });
    }
  }

  private async setStoreStatus(authToken: string, bizStatus: 1 | 2) {
    const endpoint = 'POST /v1/shop/shop/setStatus';
    const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, biz_status: bizStatus, auto_switch: 1 }),
    });
    const body = parseJsonKeepingIds(await response.text());
    if (!response.ok || body.errno !== 0) {
      throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
    }
  }

  private async finalize(emergencyId: string, action: EmergencyAction) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id: emergencyId },
      include: { targets: true },
    });
    if (!emergency) return;
    const now = new Date();
    if (action === 'offline') {
      const succeeded = emergency.targets.filter(target => target.offlineStatus === 'done').length;
      const failed = emergency.targets.length - succeeded;
      await this.prisma.storeEmergency.update({
        where: { id: emergencyId },
        data: {
          status: succeeded === emergency.targets.length ? 'offline' : succeeded > 0 ? 'partial_success' : 'failed',
          offlineAt: succeeded > 0 ? now : null,
          finishedAt: succeeded === 0 ? now : null,
          errorMessage: failed > 0 ? `${failed} of ${emergency.targets.length} store(s) could not be turned off` : null,
        },
      });
      return;
    }

    const offlineSucceeded = emergency.targets.filter(target => target.offlineStatus === 'done').length;
    const restored = emergency.targets.filter(target => target.restoreStatus === 'done').length;
    const restoreFailed = emergency.targets.filter(target => target.offlineStatus === 'done' && target.restoreStatus === 'failed').length;
    await this.prisma.storeEmergency.update({
      where: { id: emergencyId },
      data: {
        status: restored === emergency.targets.length
          ? 'restored'
          : restored > 0 ? 'partial_restored' : 'restore_failed',
        restoredAt: restored > 0 ? now : null,
        finishedAt: now,
        errorMessage: restoreFailed > 0 || offlineSucceeded < emergency.targets.length
          ? `${restored}/${emergency.targets.length} store(s) restored; ${restoreFailed} restore failure(s)`
          : null,
      },
    });
  }

  private async failEmergency(emergencyId: string, action: EmergencyAction, message: string) {
    await this.prisma.storeEmergency.updateMany({
      where: { id: emergencyId },
      data: {
        status: action === 'offline' ? 'failed' : 'restore_failed',
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
  }

  @OnWorkerEvent('failed')
  async failed(job: Job<{ emergencyId: string; action: EmergencyAction }> | undefined, error: Error) {
    if (job) await this.failEmergency(job.data.emergencyId, job.data.action, error.message);
  }
}
