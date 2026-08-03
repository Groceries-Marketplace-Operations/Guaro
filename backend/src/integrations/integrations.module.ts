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
import { AutoTurnOffCoordinator } from './auto-turn-off.processor';
import { AutoTurnOffShopProcessor } from './auto-turn-off-shop.processor';
import { AutoTurnOffScheduler } from './auto-turn-off.scheduler';
import {
  AutoTurnOffMexicoProcessor,
  AutoTurnOffColombiaProcessor,
  AutoTurnOffCostaRicaProcessor,
} from './auto-turn-off-country.processors';
import { CatalogModule } from '../catalog/catalog.module';
import { AutoFetchController } from './auto-fetch.controller';
import { AutoFetchService } from './auto-fetch.service';
import { AutoFetchScheduler } from './auto-fetch.scheduler';
import { AutoFetchProcessor } from './auto-fetch.processor';
import { StoreEmergencyController } from './store-emergency.controller';
import { StoreEmergencyService } from './store-emergency.service';
import { StoreEmergencyProcessor } from './store-emergency.processor';
import { StoreEmergencyScheduler } from './store-emergency.scheduler';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'auto-open' }),
    BullModule.registerQueue({ name: 'auto-turn-off-MX' }),
    BullModule.registerQueue({ name: 'auto-turn-off-CO' }),
    BullModule.registerQueue({ name: 'auto-turn-off-CR' }),
    BullModule.registerQueue({ name: 'auto-turn-off-shop' }),
    BullModule.registerQueue({ name: 'auto-fetch' }),
    BullModule.registerQueue({ name: 'store-emergency' }),
    PrismaModule,
    WebhooksModule,
    ConfigModule,
    CatalogModule,
  ],
  controllers: [AutoOpenPoolsController, AutoTurnOffController, AutoFetchController, StoreEmergencyController],
  providers: [
    AutoOpenPoolsService,
    AutoOpenProcessor,
    AutoOpenScheduler,
    AutoTurnOffService,
    AutoTurnOffCoordinator,
    AutoTurnOffMexicoProcessor,
    AutoTurnOffColombiaProcessor,
    AutoTurnOffCostaRicaProcessor,
    AutoTurnOffShopProcessor,
    AutoTurnOffScheduler,
    AutoFetchService,
    AutoFetchScheduler,
    AutoFetchProcessor,
    StoreEmergencyService,
    StoreEmergencyProcessor,
    StoreEmergencyScheduler,
  ],
})
export class IntegrationsModule {}
