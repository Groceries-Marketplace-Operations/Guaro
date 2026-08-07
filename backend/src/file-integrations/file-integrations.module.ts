import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FileIntegrationProcessor } from './file-integration.processor';
import { FileIntegrationScheduler } from './file-integration.scheduler';
import { FileIntegrationsController } from './file-integrations.controller';
import { FileIntegrationsService } from './file-integrations.service';
import { PromotionApiController } from './promotion-api.controller';
import { PromotionApiService } from './promotion-api.service';
import { SftpConnectionService } from './sftp-connection.service';
import { BrandPromotionsController } from './brand-promotions.controller';
import { BrandPromotionsService } from './brand-promotions.service';
import { StorePromotionStorageService } from './store-promotion-storage.service';
import { TargetedPromotionReaderService } from './targeted-promotion-reader.service';
import { TargetedMenuController } from './targeted-menu.controller';
import { TargetedMenuProcessor } from './targeted-menu.processor';
import { TargetedMenuScheduler } from './targeted-menu.scheduler';
import { TargetedMenuService } from './targeted-menu.service';
import { MenuCopyController } from './menu-copy.controller';
import { MenuCopyProcessor } from './menu-copy.processor';
import { MenuCopyService } from './menu-copy.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'file-integrations' }),
    BullModule.registerQueue({ name: 'targeted-menu' }),
    BullModule.registerQueue({ name: 'menu-copy' }),
  ],
  controllers: [FileIntegrationsController, PromotionApiController, BrandPromotionsController, TargetedMenuController, MenuCopyController],
  providers: [
    FileIntegrationsService,
    FileIntegrationProcessor,
    FileIntegrationScheduler,
    SftpConnectionService,
    StorePromotionStorageService,
    TargetedPromotionReaderService,
    PromotionApiService,
    BrandPromotionsService,
    TargetedMenuService,
    TargetedMenuProcessor,
    TargetedMenuScheduler,
    MenuCopyService,
    MenuCopyProcessor,
  ],
  exports: [TargetedPromotionReaderService],
})
export class FileIntegrationsModule {}
