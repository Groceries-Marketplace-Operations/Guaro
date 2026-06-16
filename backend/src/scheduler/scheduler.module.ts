import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from '../tasks/tasks.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), TasksModule, WebhooksModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
