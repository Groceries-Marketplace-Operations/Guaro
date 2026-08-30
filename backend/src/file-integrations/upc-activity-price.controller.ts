import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { UpsertUpcActivityPriceRuleDto } from './dto/upsert-upc-activity-price-rule.dto';
import { UpcActivityPriceService } from './upc-activity-price.service';

@Controller('integrations/upc-activity-price')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class UpcActivityPriceController {
  constructor(private readonly service: UpcActivityPriceService) {}

  @Get('rules')
  list() { return this.service.list(); }

  @Get('executions/:id')
  execution(@Param('id') id: string) { return this.service.execution(id); }

  @Post('rules')
  @Permissions('integrations.custom.configure')
  create(@Body() dto: UpsertUpcActivityPriceRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch('rules/:id')
  @Permissions('integrations.custom.configure')
  update(@Param('id') id: string, @Body() dto: UpsertUpcActivityPriceRuleDto, @CurrentUser() user: JwtUser) {
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
