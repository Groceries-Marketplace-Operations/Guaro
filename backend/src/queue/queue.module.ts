import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TasksModule } from '../tasks/tasks.module';
import { TaskEngineService } from '../tasks/task-engine.service';
import { HandlerProcessor } from './handler.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

// Register all concrete handler implementations
import './handlers/index';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      }),
    }),
    BullModule.registerQueue({ name: 'handlers' }),
    TasksModule,
    PrismaModule,
    ConfigModule,
    WebhooksModule,
  ],
  providers: [HandlerProcessor],
})
export class QueueModule implements OnModuleInit {
  constructor(
    @InjectQueue('handlers') private queue: Queue,
    private engine: TaskEngineService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.engine.emitAutoStep = (stepInstanceId: string, handlerId: string, taskId: string) => {
      this.prisma.handler.findUnique({ where: { id: handlerId } })
        .then((handler) => {
          if (!handler) throw new Error(`Handler record not found: ${handlerId}`);
          return this.queue.add(
            'run-handler',
            { stepInstanceId, handlerName: handler.name, taskId },
            { jobId: stepInstanceId },
          );
        })
        .catch((err) => console.error('Queue emit error:', err));
    };
  }
}
