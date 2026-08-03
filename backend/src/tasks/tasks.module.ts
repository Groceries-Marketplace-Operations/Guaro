import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TaskEngineService } from './task-engine.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskValidationService } from './task-validation.service';

@Module({
  imports: [WebhooksModule],
  controllers: [TasksController],
  providers: [TasksService, TaskEngineService, TaskValidationService],
  exports: [TaskEngineService],
})
export class TasksModule {}
