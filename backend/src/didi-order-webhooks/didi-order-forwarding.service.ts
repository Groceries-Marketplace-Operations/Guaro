import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { encrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

export const DIDI_ORDER_FORWARDING_QUEUE = 'didi-order-forwarding';

export interface EnqueueDidiOrderForwardingInput {
  applicationId: string;
  requestId: string;
  orderId: string;
  eventType: 'orderNew';
  rawBody: Buffer;
}

@Injectable()
export class DidiOrderForwardingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DidiOrderForwardingService.name);
  private readonly encryptionKey: string;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoveryRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(DIDI_ORDER_FORWARDING_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
  }

  onModuleInit() {
    void this.recoverPendingDeliveries();
    this.recoveryTimer = setInterval(
      () => void this.recoverPendingDeliveries(),
      30_000,
    );
    this.recoveryTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async persist(input: EnqueueDidiOrderForwardingInput): Promise<string | null> {
    if (input.eventType !== 'orderNew') return null;
    const target = await this.prisma.didiOrderWebhookForwardTarget.findUnique({
      where: { applicationId: input.applicationId },
      select: {
        id: true,
        enabled: true,
        revision: true,
        urlEncrypted: true,
        hostname: true,
      },
    });
    if (!target?.enabled) return null;

    let delivery: { id: string };
    try {
      delivery = await this.prisma.didiOrderWebhookForwardDelivery.create({
        data: {
          targetId: target.id,
          orderId: input.orderId,
          eventType: input.eventType,
          targetRevision: target.revision,
          urlEncrypted: target.urlEncrypted,
          hostname: target.hostname,
          payloadEncrypted: encrypt(input.rawBody.toString('base64'), this.encryptionKey),
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }

    return delivery.id;
  }

  publish(deliveryId: string) {
    void this.publishDelivery(deliveryId);
  }

  private async publishDelivery(deliveryId: string) {
    try {
      await this.scheduleDelivery(deliveryId, false);
    } catch {
      try {
        await this.prisma.didiOrderWebhookForwardDelivery.updateMany({
          where: { id: deliveryId, status: 'queued' },
          data: {
            errorMessage: 'Forwarding job could not be queued',
          },
        });
      } catch {
        // The durable queued row remains recoverable even if audit update fails.
      }
      this.logger.warn('A forwarding delivery could not be published to the queue');
    }
  }

  private async recoverPendingDeliveries() {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    try {
      const staleBefore = new Date(Date.now() - 2 * 60_000);
      const pending = await this.prisma.didiOrderWebhookForwardDelivery.findMany({
        where: {
          payloadEncrypted: { not: null },
          OR: [
            { status: 'queued' },
            { status: 'processing', updatedAt: { lt: staleBefore } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const delivery of pending) {
        try {
          await this.scheduleDelivery(delivery.id, true);
        } catch {
          this.logger.warn('A forwarding delivery is waiting to be re-queued');
        }
      }
    } catch {
      this.logger.warn('Pending forwarding deliveries could not be recovered');
    } finally {
      this.recoveryRunning = false;
    }
  }

  private async scheduleDelivery(deliveryId: string, inspectExisting: boolean) {
    if (inspectExisting) {
      const existing = await this.queue.getJob(deliveryId);
      if (existing) {
        const state = await existing.getState();
        const liveStates = new Set([
          'active',
          'waiting',
          'delayed',
          'waiting-children',
          'prioritized',
        ]);
        if (liveStates.has(state)) return;
        await existing.remove();
      }
    }
    await this.queue.add(
      'forward-order-new',
      { deliveryId },
      {
        jobId: deliveryId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );
  }
}
