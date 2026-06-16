import { Body, Controller, DefaultValuePipe, Delete, ForbiddenException, Get, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole, AssignmentMode, Country, KaType, MenuIntegration, PaymentMode, PickingMode } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BrandsService } from './brands.service';
import { AddRuleCandidateDto } from './dto/add-rule-candidate.dto';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Controller('brands')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BrandsController {
  constructor(private brandsService: BrandsService) {}

  // ── BrandAssignmentRules (rutas fijas ANTES de :id) ──────────────────────

  @Get('assignment-rules')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  findAllRules() {
    return this.brandsService.findAllRules();
  }

  @Patch('assignment-rules/:ruleId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  updateRule(@Param('ruleId') ruleId: string, @Body('modo') modo: AssignmentMode) {
    return this.brandsService.updateRule(ruleId, modo);
  }

  @Post('assignment-rules/:ruleId/candidates')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  addRuleCandidate(@Param('ruleId') ruleId: string, @Body() dto: AddRuleCandidateDto) {
    return this.brandsService.addRuleCandidate(ruleId, dto);
  }

  @Delete('assignment-rules/:ruleId/candidates/:accountId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeRuleCandidate(@Param('ruleId') ruleId: string, @Param('accountId') accountId: string) {
    return this.brandsService.removeRuleCandidate(ruleId, accountId);
  }

  // ── Brands ────────────────────────────────────────────────────────────────

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll(
    @CurrentUser() u: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('country') country?: Country,
    @Query('kaType') kaType?: KaType,
    @Query('menuIntegration') menuIntegration?: MenuIntegration,
    @Query('pickingMode') pickingMode?: PickingMode,
    @Query('paymentMode') paymentMode?: PaymentMode,
    @Query('myBrands', new DefaultValuePipe(false), ParseBoolPipe) myBrands?: boolean,
  ) {
    return this.brandsService.findAll(u.roles, u.id, { page, limit, q, country, kaType, menuIntegration, pickingMode, paymentMode, myBrands });
  }

  @Get(':id')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findOne(@Param('id') id: string) {
    return this.brandsService.findOne(id);
  }

  @Post()
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateBrandDto) {
    const isBpoOnly = u.roles.includes(AccountRole.bpo) && !u.roles.includes(AccountRole.admin) && !u.roles.includes(AccountRole.super_admin);
    if (isBpoOnly && !u.bpoPermissions.includes('create_brand')) {
      throw new ForbiddenException('You do not have permission to create brands');
    }
    return this.brandsService.create(dto, u.id);
  }

  @Patch(':id')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body() dto: UpdateBrandDto) {
    return this.brandsService.update(id, dto, u.id, u.roles);
  }

  @Delete(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.brandsService.remove(id);
  }
}
