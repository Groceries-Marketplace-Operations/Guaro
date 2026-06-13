import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  myActiveTasks(@CurrentUser() u: any) {
    return this.bpoManagementService.myActiveTasks(u.id);
  }

  // BPO: mi performance
  @Get('my-performance')
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  myPerformance(@CurrentUser() u: any) {
    return this.bpoManagementService.myPerformance(u.id);
  }

  // Admin: performance de todo el team
  @Get('team')
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  teamPerformance(@CurrentUser() u: any) {
    return this.bpoManagementService.teamPerformance(u.roles, u.sectionId);
  }

  // Admin: histórico completo del team
  @Get('team/history')
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  teamHistory(@CurrentUser() u: any) {
    return this.bpoManagementService.teamHistory(u.roles, u.sectionId);
  }

  // Admin: performance de un BPO específico
  @Get('team/:accountId')
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  bpoPerformance(@Param('accountId') accountId: string) {
    return this.bpoManagementService.bpoPerformance(accountId);
  }
}
