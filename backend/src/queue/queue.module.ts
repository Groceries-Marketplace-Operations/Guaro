import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TasksModule } from '../tasks/tasks.module';
import { TaskEngineService } from '../tasks/task-engine.service';
import { HandlerProcessor } from './handler.processor';

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
  ],
  providers: [HandlerProcessor],
})
export class QueueModule implements OnModuleInit {
  constructor(
    @InjectQueue('handlers') private queue: Queue,
    private engine: TaskEngineService,
  ) {}

  onModuleInit() {
    // Inyectar la función de emisión en el engine (evita circular dep)
    this.engine.emitAutoStep = (stepInstanceId: string, handlerId: string) => {
      this.queue.add(
        'run-handler',
        { stepInstanceId, handlerName: handlerId },
        { jobId: stepInstanceId }, // idempotente
      ).catch((err) => console.error('Queue add error:', err));
    };
  }
}
