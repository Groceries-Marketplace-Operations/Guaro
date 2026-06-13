import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRol, AsignacionModo } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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

  // ── Brands ────────────────────────────────────────────────────────────────

  @Get()
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findAll(@CurrentUser() u: any) {
    return this.brandsService.findAll(u.roles, u.id);
  }

  @Get(':id')
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findOne(@Param('id') id: string) {
    return this.brandsService.findOne(id);
  }

  @Post()
  @Roles(AccountRol.admin, AccountRol.super_admin)
  create(@CurrentUser() u: any, @Body() dto: CreateBrandDto) {
    return this.brandsService.create(dto, u.id);
  }

  @Patch(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  update(@Param('id') id: string, @Body() dto: UpdateBrandDto) {
    return this.brandsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  remove(@Param('id') id: string) {
    return this.brandsService.remove(id);
  }

  // ── BrandAssignmentRules ──────────────────────────────────────────────────

  @Get('assignment-rules')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  findAllRules() {
    return this.brandsService.findAllRules();
  }

  @Patch('assignment-rules/:ruleId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  updateRule(@Param('ruleId') ruleId: string, @Body('modo') modo: AsignacionModo) {
    return this.brandsService.updateRule(ruleId, modo);
  }

  @Post('assignment-rules/:ruleId/candidates')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  addRuleCandidate(@Param('ruleId') ruleId: string, @Body() dto: AddRuleCandidateDto) {
    return this.brandsService.addRuleCandidate(ruleId, dto);
  }

  @Delete('assignment-rules/:ruleId/candidates/:accountId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeRuleCandidate(@Param('ruleId') ruleId: string, @Param('accountId') accountId: string) {
    return this.brandsService.removeRuleCandidate(ruleId, accountId);
  }
}
