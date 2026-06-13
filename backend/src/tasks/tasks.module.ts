import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TaskEngineService } from './task-engine.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [WebhooksModule],
  controllers: [TasksController],
  providers: [TasksService, TaskEngineService],
  exports: [TaskEngineService],
})
export class TasksModule {}
