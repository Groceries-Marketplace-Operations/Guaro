import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import * as http from 'http';
import * as https from 'https';
import { isIP } from 'net';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  ForwardingUrlError,
  resolveForwardingAddress,
  validateForwardingUrl,
} from './didi-order-forwarding-url.util';
import { DIDI_ORDER_FORWARDING_QUEUE } from './didi-order-forwarding.service';

const FORWARD_TIMEOUT_MS = 5_000;

interface ForwardingJobData {
  deliveryId: string;
}

class ForwardingAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

@Injectable()
@Processor(DIDI_ORDER_FORWARDING_QUEUE, { concurrency: 8 })
export class DidiOrderForwardingProcessor extends WorkerHost {
  private readonly logger = new Logger(DidiOrderForwardingProcessor.name);
  private readonly encryptionKey: string;
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super();
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.production = config.get<string>('NODE_ENV') === 'production';
  }

  async process(job: Job<ForwardingJobData>) {
    const delivery = await this.prisma.didiOrderWebhookForwardDelivery.findUnique({
      where: { id: job.data.deliveryId },
      select: {
        id: true,
        status: true,
        eventType: true,
        targetRevision: true,
        urlEncrypted: true,
        hostname: true,
        payloadEncrypted: true,
        startedAt: true,
        target: {
          select: {
            enabled: true,
            revision: true,
          },
        },
      },
    });
    if (!delivery || delivery.status === 'delivered' || delivery.status === 'failed') return;

    const attempt = job.attemptsMade + 1;
    const maxAttempts = Math.max(1, Number(job.opts.attempts ?? 3));
    await this.prisma.didiOrderWebhookForwardDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'processing',
        attempts: attempt,
        startedAt: delivery.startedAt ?? new Date(),
        httpStatus: null,
        errorMessage: null,
      },
    });

    try {
      if (!delivery.target.enabled) {
        throw new ForwardingAttemptError('Forwarding target is disabled', false);
      }
      if (delivery.targetRevision !== delivery.target.revision) {
        throw new ForwardingAttemptError('Forwarding target configuration changed', false);
      }
      if (delivery.eventType !== 'orderNew') {
        throw new ForwardingAttemptError('Only orderNew events can be forwarded', false);
      }
      if (!delivery.payloadEncrypted) {
        throw new ForwardingAttemptError('Forwarding payload is unavailable', false);
      }

      let rawBody: Buffer;
      let clearUrl: string;
      try {
        rawBody = Buffer.from(decrypt(delivery.payloadEncrypted, this.encryptionKey), 'base64');
        clearUrl = decrypt(delivery.urlEncrypted, this.encryptionKey);
      } catch {
        throw new ForwardingAttemptError('Forwarding delivery could not be decrypted', false);
      }

      let parsedUrl: URL;
      try {
        const validated = validateForwardingUrl(clearUrl, this.production);
        if (validated.hostname !== delivery.hostname) {
          throw new ForwardingUrlError('Forwarding hostname integrity check failed');
        }
        parsedUrl = new URL(validated.url);
      } catch (error) {
        const message = error instanceof ForwardingUrlError
          ? error.message
          : 'Forwarding URL is invalid';
        throw new ForwardingAttemptError(message, false);
      }

      let resolved: Awaited<ReturnType<typeof resolveForwardingAddress>>;
      try {
        resolved = await resolveForwardingAddress(parsedUrl, this.production);
      } catch (error) {
        const message = error instanceof ForwardingUrlError
          ? error.message
          : 'Forwarding hostname could not be resolved';
        const retryable = message.includes('could not be resolved');
        throw new ForwardingAttemptError(message, retryable);
      }

      const status = await this.send(parsedUrl, resolved, rawBody, delivery.id);
      if (status >= 200 && status < 300) {
        await this.prisma.didiOrderWebhookForwardDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            payloadEncrypted: null,
            httpStatus: status,
            errorMessage: null,
            deliveredAt: new Date(),
            failedAt: null,
          },
        });
        return;
      }

      const retryable = status === 408 || status === 429 || status >= 500;
      throw new ForwardingAttemptError(
        `Forwarding endpoint returned HTTP ${status}`,
        retryable,
        status,
      );
    } catch (error) {
      const failure = error instanceof ForwardingAttemptError
        ? error
        : new ForwardingAttemptError('Forwarding request failed', true);
      const retry = failure.retryable && attempt < maxAttempts;
      await this.prisma.didiOrderWebhookForwardDelivery.update({
        where: { id: delivery.id },
        data: retry
          ? {
            status: 'queued',
            httpStatus: failure.httpStatus,
            errorMessage: failure.message,
          }
          : {
            status: 'failed',
            payloadEncrypted: null,
            httpStatus: failure.httpStatus,
            errorMessage: failure.message,
            failedAt: new Date(),
          },
      });
      if (failure.retryable) throw failure;
    }
  }

  private send(
    url: URL,
    resolved: { address: string; family: number },
    rawBody: Buffer,
    deliveryId: string,
  ) {
    return new Promise<number>((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const certificateHostname = url.hostname.replace(/^\[|\]$/g, '');
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const request = client.request({
        protocol: url.protocol,
        hostname: resolved.address,
        family: resolved.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        servername: url.protocol === 'https:' && isIP(certificateHostname) === 0
          ? certificateHostname
          : undefined,
        headers: {
          Host: url.host,
          'Content-Type': 'application/json',
          'Content-Length': rawBody.byteLength,
          'X-Guaro-Delivery-Id': deliveryId,
          'X-Guaro-Event': 'orderNew',
        },
      }, response => {
        const status = response.statusCode ?? 0;
        // The response body is irrelevant. Close immediately after receiving
        // the status so a peer cannot retain sockets by never finishing it.
        finish(() => {
          response.destroy();
          resolve(status);
        });
      });
      const timer = setTimeout(() => {
        request.destroy();
        finish(() => reject(new ForwardingAttemptError('Forwarding request timed out', true)));
      }, FORWARD_TIMEOUT_MS);
      request.once('error', () => {
        finish(() => reject(new ForwardingAttemptError('Forwarding request failed', true)));
      });
      request.end(rawBody);
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ForwardingJobData> | undefined) {
    if (job) this.logger.warn(`Forwarding delivery ${job.data.deliveryId} failed an attempt`);
  }
}
