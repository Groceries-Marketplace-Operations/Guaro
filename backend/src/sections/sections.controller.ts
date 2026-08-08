import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { SectionsService } from './sections.service';

@Controller('sections')
@Permissions('sections.manage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SectionsController {
  constructor(private sectionsService: SectionsService) {}

  @Get()
  @Permissions('sections.view', 'config.users', 'config.invitations')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll(@CurrentUser() u: JwtUser) {
    return this.sectionsService.findAll(u.roles, u.sectionId);
  }

  @Post()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  create(@Body('name') name: string) {
    return this.sectionsService.create(name);
  }

  @Get('role-access')
  @Roles(AccountRole.super_admin)
  roleAccess() {
    return this.sectionsService.getRoleAccess();
  }

  @Put('role-access/:role')
  @Roles(AccountRole.super_admin)
  updateRoleAccess(@Param('role') role: AccountRole, @Body('sectionIds') sectionIds: string[]) {
    return this.sectionsService.updateRoleAccess(role, sectionIds);
  }

  @Patch('reorder')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  reorder(@Body('order') order: { id: string; order: number }[]) {
    return this.sectionsService.reorder(order);
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @Body('name') name: string) {
    return this.sectionsService.update(id, name);
  }
}
