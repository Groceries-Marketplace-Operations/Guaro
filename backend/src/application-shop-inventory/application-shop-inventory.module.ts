import { Module } from '@nestjs/common';
import { FileIntegrationsModule } from '../file-integrations/file-integrations.module';
import { ApplicationShopInventoryController } from './application-shop-inventory.controller';
import { ApplicationShopInventoryService } from './application-shop-inventory.service';

@Module({
  imports: [FileIntegrationsModule],
  controllers: [ApplicationShopInventoryController],
  providers: [ApplicationShopInventoryService],
})
export class ApplicationShopInventoryModule {}
