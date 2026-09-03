import { Module } from '@nestjs/common';
import { DidiOrderWebhooksController } from './didi-order-webhooks.controller';
import { DidiOrderWebhooksService } from './didi-order-webhooks.service';
import { DidiOrderWebhookEventsController } from './didi-order-webhook-events.controller';
import { DidiOrderWebhookEventsService } from './didi-order-webhook-events.service';

@Module({
  controllers: [DidiOrderWebhooksController, DidiOrderWebhookEventsController],
  providers: [DidiOrderWebhooksService, DidiOrderWebhookEventsService],
})
export class DidiOrderWebhooksModule {}
