import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { BrandMenuController } from './brand-menu.controller';
import { CatalogSyncService } from './catalog-sync.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [BrandMenuController],
  providers: [CatalogSyncService],
  exports: [CatalogSyncService],
})
export class CatalogModule {}
