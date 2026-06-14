import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SectionsService } from './sections.service';

@Controller('sections')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SectionsController {
  constructor(private sectionsService: SectionsService) {}

  @Get()
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll(@CurrentUser() u: JwtUser) {
    return this.sectionsService.findAll(u.roles, u.sectionId);
  }

  @Post()
  @Roles(AccountRole.super_admin)
  create(@Body('name') name: string) {
    return this.sectionsService.create(name);
  }

  @Patch(':id')
  @Roles(AccountRole.super_admin)
  update(@Param('id') id: string, @Body('name') name: string) {
    return this.sectionsService.update(id, name);
  }
}
