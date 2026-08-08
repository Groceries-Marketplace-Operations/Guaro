import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateMenuCopyDto } from './dto/create-menu-copy.dto';
import { MenuCopyService } from './menu-copy.service';

@Controller('integrations/menu-copy')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class MenuCopyController {
  constructor(private readonly service: MenuCopyService) {}

  @Get('executions')
  list() {
    return this.service.list();
  }

  @Post('executions')
  create(@Body() dto: CreateMenuCopyDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Post('executions/:id/stop')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
}
