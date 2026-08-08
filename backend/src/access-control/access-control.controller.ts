import { BadRequestException, Body, Controller, Get, Param, ParseEnumPipe, Put, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AccessControlService } from './access-control.service';

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
  ) {
    if (body.permissions !== undefined && !Array.isArray(body.permissions)) {
      throw new BadRequestException('permissions must be an array');
    }
    if (body.sectionIds !== undefined && !Array.isArray(body.sectionIds)) {
      throw new BadRequestException('sectionIds must be an array');
    }
    return this.service.updateRole(role, body.permissions ?? [], body.sectionIds ?? []);
  }
}
