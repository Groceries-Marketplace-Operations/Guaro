import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from '../tasks/tasks.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SchedulerService } from './scheduler.service';
import { IntegrationLogsCleanupService } from './integration-logs-cleanup.service';

@Module({
  imports: [ScheduleModule.forRoot(), TasksModule, WebhooksModule],
  providers: [SchedulerService, IntegrationLogsCleanupService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
