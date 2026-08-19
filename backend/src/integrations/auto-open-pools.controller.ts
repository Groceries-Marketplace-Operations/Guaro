import {
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, Query, DefaultValuePipe, UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AutoOpenPoolsService } from './auto-open-pools.service';
import { CreatePoolDto } from './dto/create-pool.dto';
import { UpdatePoolDto } from './dto/update-pool.dto';
import { SendNotificationDto } from './dto/send-notification.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('integrations/auto-open')
@Permissions('integrations.forced_open')
export class AutoOpenPoolsController {
  constructor(private svc: AutoOpenPoolsService) {}

  @Get('capabilities')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  capabilities() {
    return this.svc.capabilities();
  }

  @Get('pools')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  list() {
    return this.svc.list();
  }

  @Post('pools')
  @Permissions('integrations.forced_open.configure')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  create(@Body() dto: CreatePoolDto) {
    return this.svc.create(dto);
  }

  @Patch('pools/:id')
  @Permissions('integrations.forced_open.configure')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @Body() dto: UpdatePoolDto) {
    return this.svc.update(id, dto);
  }

  @Delete('pools/:id')
  @Permissions('integrations.forced_open.configure')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post('pools/:id/run')
  @Permissions('integrations.forced_open.execute')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  runNow(@Param('id') id: string) {
    return this.svc.runNow(id);
  }

  @Get('pools/:id/executions')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  executions(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.svc.listExecutions(id, page, limit);
  }

  @Post('notify')
  @Permissions('integrations.forced_open.execute')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  notify(@Body() dto: SendNotificationDto) {
    return this.svc.sendNotification(dto);
  }
}
