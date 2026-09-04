import { Module } from '@nestjs/common';
import { DidiOrderWebhooksController } from './didi-order-webhooks.controller';
import { DidiOrderWebhooksService } from './didi-order-webhooks.service';
import { DidiOrderWebhookEventsController } from './didi-order-webhook-events.controller';
import { DidiOrderWebhookEventsService } from './didi-order-webhook-events.service';
import { CentralDidiOrderWebhookEventsController } from './central-didi-order-webhook-events.controller';
import { FileIntegrationsModule } from '../file-integrations/file-integrations.module';

@Module({
  imports: [FileIntegrationsModule],
  controllers: [
    DidiOrderWebhooksController,
    DidiOrderWebhookEventsController,
    CentralDidiOrderWebhookEventsController,
  ],
  providers: [DidiOrderWebhooksService, DidiOrderWebhookEventsService],
})
export class DidiOrderWebhooksModule {}
