import { Module } from '@nestjs/common';
import { CompletionRateOrderService } from './completion-rate-order.service';
import { BullModule } from '@nestjs/bullmq';
import { DidiOrderWebhooksController } from './didi-order-webhooks.controller';
import { DidiOrderWebhooksService } from './didi-order-webhooks.service';
import { DidiOrderWebhookEventsController } from './didi-order-webhook-events.controller';
import { DidiOrderWebhookEventsService } from './didi-order-webhook-events.service';
import { CentralDidiOrderWebhookEventsController } from './central-didi-order-webhook-events.controller';
import { FileIntegrationsModule } from '../file-integrations/file-integrations.module';
import { DidiOrderForwardingProcessor } from './didi-order-forwarding.processor';
import {
  DIDI_ORDER_FORWARDING_QUEUE,
  DidiOrderForwardingService,
} from './didi-order-forwarding.service';

@Module({
  imports: [
    FileIntegrationsModule,
    BullModule.registerQueue({ name: DIDI_ORDER_FORWARDING_QUEUE }),
  ],
  controllers: [
    DidiOrderWebhooksController,
    DidiOrderWebhookEventsController,
    CentralDidiOrderWebhookEventsController,
  ],
  providers: [
    CompletionRateOrderService,
    DidiOrderWebhooksService,
    DidiOrderWebhookEventsService,
    DidiOrderForwardingService,
    DidiOrderForwardingProcessor,
  ],
})
export class DidiOrderWebhooksModule {}
