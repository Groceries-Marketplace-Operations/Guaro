import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEvent } from '@prisma/client';

export interface WebhookPayload {
  text: string;
  attachments?: {
    title?: string;
    text?: string;
    color?: string;
    images?: { url: string }[];
  }[];
}

@Injectable()
export class WebhookSenderService {
  private readonly logger = new Logger(WebhookSenderService.name);

  constructor(private prisma: PrismaService) {}

  async sendForStep(stepDefinitionId: string, event: WebhookEvent, payload: WebhookPayload) {
    const stepWebhooks = await this.prisma.stepWebhook.findMany({
      where: { stepDefinitionId },
      include: { webhook: true },
    });

    const targets = stepWebhooks.filter((sw) => sw.events.includes(event));
    await Promise.allSettled(targets.map((sw) => this.send(sw.webhook.url, payload)));
  }

  async sendAlert(payload: WebhookPayload) {
    const alertWebhooks = await this.prisma.webhook.findMany({ where: { isAlerts: true } });
    await Promise.allSettled(alertWebhooks.map((w) => this.send(w.url, payload)));
  }

  private async send(url: string, payload: WebhookPayload) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.logger.error(`Webhook failed [${url}]: ${(err as Error).message}`);
    }
  }
}
