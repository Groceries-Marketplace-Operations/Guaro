import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateMassiveRtboExecutionDto } from './dto/create-massive-rtbo-execution.dto';
import { MassiveRtboService } from './massive-rtbo.service';

@Controller('integrations/massive-rtbo')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class MassiveRtboController {
  constructor(private readonly service: MassiveRtboService) {}

  @Get('executions')
  list() {
    return this.service.list();
  }

  @Post('executions')
  @Permissions('integrations.custom.execute')
  create(@Body() dto: CreateMassiveRtboExecutionDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Post('executions/:id/stop')
  @Permissions('integrations.custom.execute')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
}
