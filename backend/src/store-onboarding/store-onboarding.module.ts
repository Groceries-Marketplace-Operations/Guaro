import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreOnboardingConfigService } from './store-onboarding-config.service';
import { StoreOnboardingController } from './store-onboarding.controller';
import { StoreOnboardingLifecycleService } from './store-onboarding-lifecycle.service';
import { StoreOnboardingGoLiveGateway } from './store-onboarding-go-live.gateway';
import { StoreOnboardingNotificationDispatcherService } from './store-onboarding-notification-dispatcher.service';
import { StoreOnboardingService } from './store-onboarding.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [StoreOnboardingController],
  providers: [
    StoreOnboardingConfigService,
    StoreOnboardingLifecycleService,
    StoreOnboardingService,
    StoreOnboardingGoLiveGateway,
    StoreOnboardingNotificationDispatcherService,
  ],
  exports: [StoreOnboardingConfigService, StoreOnboardingLifecycleService, StoreOnboardingService],
})
export class StoreOnboardingModule {}
