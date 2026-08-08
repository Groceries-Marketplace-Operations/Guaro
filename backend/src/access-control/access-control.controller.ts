import { Body, Controller, DefaultValuePipe, Get, Param, ParseEnumPipe, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { AccessControlService, LayeredPolicyInput } from './access-control.service';

@Controller('access-control')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.super_admin)
export class AccessControlController {
  constructor(private service: AccessControlService) {}

  @Get('matrix')
  matrix() {
    return this.service.matrix();
  }

  @Put('roles/:role')
  updateRole(
    @Param('role', new ParseEnumPipe(AccountRole)) role: AccountRole,
    @Body() body: { permissions?: string[]; sectionIds?: string[] },
    @CurrentUser() actor: JwtUser,
  ) {
    return this.service.updateRole(role, body.permissions ?? [], body.sectionIds ?? [], actor.id);
  }

  @Get('role-sections/:role/:sectionId')
  roleSectionProfile(
    @Param('role', new ParseEnumPipe(AccountRole)) role: AccountRole,
    @Param('sectionId') sectionId: string,
  ) {
    return this.service.roleSectionProfile(role, sectionId);
  }

  @Put('role-sections/:role/:sectionId')
  updateRoleSectionProfile(
    @Param('role', new ParseEnumPipe(AccountRole)) role: AccountRole,
    @Param('sectionId') sectionId: string,
    @Body() body: LayeredPolicyInput,
    @CurrentUser() actor: JwtUser,
  ) {
    return this.service.updateRoleSectionProfile(role, sectionId, body, actor.id);
  }

  @Get('accounts')
  accounts(
    @Query('q') query = '',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit = 25,
  ) {
    return this.service.accounts(query, page, limit);
  }

  @Get('area-access')
  areaAccess() {
    return this.service.areaAccess();
  }

  @Put('area-access/:area/:accountId')
  updateAreaAccess(
    @Param('area') area: string,
    @Param('accountId') accountId: string,
    @Body('permissions') permissions: unknown[],
    @CurrentUser() actor: JwtUser,
  ) {
    return this.service.updateAreaAccess(area, accountId, permissions, actor.id);
  }

  @Get('accounts/:accountId')
  accountProfile(@Param('accountId') accountId: string) {
    return this.service.accountProfile(accountId);
  }

  @Put('accounts/:accountId')
  updateAccountProfile(
    @Param('accountId') accountId: string,
    @Body() body: LayeredPolicyInput,
    @CurrentUser() actor: JwtUser,
  ) {
    return this.service.updateAccountProfile(accountId, body, actor.id);
  }

  @Get('audits')
  audits(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit = 25,
  ) {
    return this.service.audits(page, limit);
  }
}
