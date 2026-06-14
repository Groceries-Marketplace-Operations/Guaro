import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BpoManagementService } from './bpo-management.service';

@Controller('bpo-management')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BpoManagementController {
  constructor(private bpoManagementService: BpoManagementService) {}

  // BPO: mis tareas activas
  @Get('my-tasks')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  myActiveTasks(@CurrentUser() u: JwtUser) {
    return this.bpoManagementService.myActiveTasks(u.id);
  }

  // BPO: mi performance
  @Get('my-performance')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  myPerformance(@CurrentUser() u: JwtUser) {
    return this.bpoManagementService.myPerformance(u.id);
  }

  // Admin: performance de todo el team
  @Get('team')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  teamPerformance(@CurrentUser() u: JwtUser) {
    return this.bpoManagementService.teamPerformance(u.roles, u.sectionId);
  }

  // Admin: histórico completo del team
  @Get('team/history')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  teamHistory(
    @CurrentUser() u: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    return this.bpoManagementService.teamHistory(u.roles, u.sectionId, { page, limit });
  }

  // Admin: performance de un BPO específico
  @Get('team/:accountId')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  bpoPerformance(@Param('accountId') accountId: string) {
    return this.bpoManagementService.bpoPerformance(accountId);
  }
}
