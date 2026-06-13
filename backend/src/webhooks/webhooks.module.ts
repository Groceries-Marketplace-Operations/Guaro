import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSenderService } from './webhook-sender.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookSenderService],
  exports: [WebhookSenderService],
})
export class WebhooksModule {}
