import { Module } from '@nestjs/common';
import { DidiOrderWebhooksController } from './didi-order-webhooks.controller';
import { DidiOrderWebhooksService } from './didi-order-webhooks.service';

@Module({
  controllers: [DidiOrderWebhooksController],
  providers: [DidiOrderWebhooksService],
})
export class DidiOrderWebhooksModule {}
