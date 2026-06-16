import { Module } from '@nestjs/common';
import { DevWebhookController } from './dev-webhook.controller';
import { DevSchedulerController } from './dev-scheduler.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [SchedulerModule],
  controllers: [DevWebhookController, DevSchedulerController],
})
export class DevModule {}
