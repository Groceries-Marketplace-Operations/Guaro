import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { BrandPromotionsService } from './brand-promotions.service';

@Controller('brands/:brandId/promotions')
@Permissions('brands.view')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BrandPromotionsController {
  constructor(private readonly promotions: BrandPromotionsService) {}

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  list(
    @Param('brandId') brandId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('shopExternalId') shopExternalId?: string,
    @Query('activityType') activityType?: string,
  ) {
    return this.promotions.list(brandId, { page, limit, q, shopExternalId, activityType });
  }
}
