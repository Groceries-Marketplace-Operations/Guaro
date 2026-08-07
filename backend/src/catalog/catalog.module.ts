import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { BrandMenuController } from './brand-menu.controller';
import { CatalogSyncService } from './catalog-sync.service';
import { BrandMenuCategoryService } from './brand-menu-category.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [BrandMenuController],
  providers: [CatalogSyncService, BrandMenuCategoryService],
  exports: [CatalogSyncService, BrandMenuCategoryService],
})
export class CatalogModule {}
