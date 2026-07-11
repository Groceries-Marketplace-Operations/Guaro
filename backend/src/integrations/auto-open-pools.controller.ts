import {
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, Query, DefaultValuePipe, UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { AutoOpenPoolsService } from './auto-open-pools.service';
import { CreatePoolDto } from './dto/create-pool.dto';
import { UpdatePoolDto } from './dto/update-pool.dto';
import { ForbiddenException } from '@nestjs/common';

function canAccess(user: JwtUser): boolean {
  if (user.roles.includes(AccountRole.super_admin)) return true;
  return user.roles.includes(AccountRole.admin) && (user.adminModules ?? []).includes('integrations');
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('integrations/auto-open')
export class AutoOpenPoolsController {
  constructor(private svc: AutoOpenPoolsService) {}

  @Get('pools')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  list(@CurrentUser() u: JwtUser) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.list();
  }

  @Post('pools')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  create(@Body() dto: CreatePoolDto, @CurrentUser() u: JwtUser) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.create(dto);
  }

  @Patch('pools/:id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @Body() dto: UpdatePoolDto, @CurrentUser() u: JwtUser) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.update(id, dto);
  }

  @Delete('pools/:id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.remove(id);
  }

  @Post('pools/:id/run')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  runNow(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.runNow(id);
  }

  @Get('pools/:id/executions')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  executions(
    @Param('id') id: string,
    @CurrentUser() u: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    if (!canAccess(u)) throw new ForbiddenException();
    return this.svc.listExecutions(id, page, limit);
  }
}
