import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CatalogSyncService } from './catalog-sync.service';

@Controller('brands/:brandId/menu')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BrandMenuController {
  constructor(private readonly catalog: CatalogSyncService) {}

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  list(
    @Param('brandId') brandId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('q') q?: string,
  ) {
    return this.catalog.listBrandItems(brandId, { page, limit, q });
  }
}
