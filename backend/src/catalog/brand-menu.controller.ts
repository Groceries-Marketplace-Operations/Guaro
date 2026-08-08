import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { CatalogSyncService } from './catalog-sync.service';
import { BrandMenuCategoryService } from './brand-menu-category.service';
import { ReplaceBrandMenuCategoriesDto } from './dto/replace-brand-menu-categories.dto';

@Controller('brands/:brandId/menu')
@Permissions('brands.view')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BrandMenuController {
  constructor(
    private readonly catalog: CatalogSyncService,
    private readonly categories: BrandMenuCategoryService,
  ) {}

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

  @Get('categories')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  listCategories(@Param('brandId') brandId: string) {
    return this.categories.list(brandId);
  }

  @Put('categories')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  replaceCategories(@Param('brandId') brandId: string, @Body() dto: ReplaceBrandMenuCategoriesDto) {
    return this.categories.replace(brandId, dto);
  }

  @Get('commercial-template')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  async downloadTemplate(@Param('brandId') brandId: string, @Res() response: Response) {
    const buffer = await this.categories.template(brandId);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="commercial-grocery-menu-template.xlsx"');
    response.send(buffer);
  }
}
