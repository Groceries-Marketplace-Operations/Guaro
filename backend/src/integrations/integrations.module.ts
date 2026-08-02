import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConfigModule } from '@nestjs/config';
import { AutoOpenPoolsController } from './auto-open-pools.controller';
import { AutoOpenPoolsService } from './auto-open-pools.service';
import { AutoOpenProcessor } from './auto-open.processor';
import { AutoOpenScheduler } from './auto-open.scheduler';
import { AutoTurnOffController } from './auto-turn-off.controller';
import { AutoTurnOffService } from './auto-turn-off.service';
import { AutoTurnOffProcessor } from './auto-turn-off.processor';
import { AutoTurnOffScheduler } from './auto-turn-off.scheduler';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'auto-open' }),
    BullModule.registerQueue({ name: 'auto-turn-off' }),
    PrismaModule,
    WebhooksModule,
    ConfigModule,
  ],
  controllers: [AutoOpenPoolsController, AutoTurnOffController],
  providers: [
    AutoOpenPoolsService,
    AutoOpenProcessor,
    AutoOpenScheduler,
    AutoTurnOffService,
    AutoTurnOffProcessor,
    AutoTurnOffScheduler,
  ],
})
export class IntegrationsModule {}
