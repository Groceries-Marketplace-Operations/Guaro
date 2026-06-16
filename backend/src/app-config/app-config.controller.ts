import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppConfigService } from './app-config.service';
import { PatchOptionDto } from './dto/patch-option.dto';
import { UpsertOptionDto } from './dto/upsert-option.dto';

@Controller('app-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppConfigController {
  constructor(private svc: AppConfigService) {}

  // All authenticated users can read config (to populate dropdowns)
  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll() {
    return this.svc.findAll();
  }

  @Get(':category')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findByCategory(@Param('category') category: string, @Query('activeOnly') activeOnly?: string) {
    void activeOnly; // filtering handled client-side for now
    return this.svc.findByCategory(category);
  }

  @Post()
  @Roles(AccountRole.super_admin)
  upsert(@Body() dto: UpsertOptionDto) {
    return this.svc.upsert(dto);
  }

  @Patch(':id')
  @Roles(AccountRole.super_admin)
  patch(@Param('id') id: string, @Body() dto: PatchOptionDto) {
    return this.svc.patch(id, dto);
  }

  @Delete(':id')
  @Roles(AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
