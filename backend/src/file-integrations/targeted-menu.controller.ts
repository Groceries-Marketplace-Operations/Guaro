import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { UpsertTargetedMenuRuleDto } from './dto/upsert-targeted-menu-rule.dto';
import { TargetedMenuService } from './targeted-menu.service';

@Controller('integrations/targeted-menu')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class TargetedMenuController {
  constructor(private readonly service: TargetedMenuService) {}

  @Get('rules')
  list() { return this.service.list(); }

  @Post('rules')
  @Permissions('integrations.custom.configure')
  create(@Body() dto: UpsertTargetedMenuRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch('rules/:id')
  @Permissions('integrations.custom.configure')
  update(@Param('id') id: string, @Body() dto: UpsertTargetedMenuRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.update(id, dto, user.id);
  }

  @Delete('rules/:id')
  @Permissions('integrations.custom.configure')
  remove(@Param('id') id: string) { return this.service.remove(id); }

  @Post('rules/:id/run')
  @Permissions('integrations.custom.execute')
  run(@Param('id') id: string, @CurrentUser() user: JwtUser) { return this.service.run(id, user.id); }

  @Post('rules/:id/stop')
  @Permissions('integrations.custom.execute')
  stop(@Param('id') id: string) { return this.service.stop(id); }
}
