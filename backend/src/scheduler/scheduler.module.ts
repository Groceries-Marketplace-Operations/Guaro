import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from '../tasks/tasks.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SchedulerService } from './scheduler.service';
import { IntegrationLogsCleanupService } from './integration-logs-cleanup.service';

const scheduledJobsEnabled = process.env.SCHEDULED_JOBS_ENABLED !== 'false';

@Module({
  imports: [
    ScheduleModule.forRoot({
      cronJobs: scheduledJobsEnabled,
      intervals: scheduledJobsEnabled,
      timeouts: scheduledJobsEnabled,
    }),
    TasksModule,
    WebhooksModule,
  ],
  providers: [SchedulerService, IntegrationLogsCleanupService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
