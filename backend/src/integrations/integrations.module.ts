import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConfigModule } from '@nestjs/config';
import { AutoOpenPoolsController } from './auto-open-pools.controller';
import { AutoOpenPoolsService } from './auto-open-pools.service';
import { AutoOpenProcessor } from './auto-open.processor';
import { AutoOpenScheduler } from './auto-open.scheduler';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'auto-open' }),
    PrismaModule,
    WebhooksModule,
    ConfigModule,
  ],
  controllers: [AutoOpenPoolsController],
  providers: [AutoOpenPoolsService, AutoOpenProcessor, AutoOpenScheduler],
})
export class IntegrationsModule {}
