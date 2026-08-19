import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateMenuHandshakeDto } from './dto/create-menu-handshake.dto';
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
  @Permissions('integrations.custom.execute')
  create(@Body() dto: CreateMenuCopyDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Post('handshake')
  @Permissions('integrations.custom.execute')
  handshake(@Body() dto: CreateMenuHandshakeDto, @CurrentUser() user: JwtUser) {
    return this.service.createHandshake(dto, user.id);
  }

  @Post('executions/:id/retry')
  @Permissions('integrations.custom.execute')
  retry(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.retry(id, user.id);
  }

  @Post('executions/:id/stop')
  @Permissions('integrations.custom.execute')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
}
