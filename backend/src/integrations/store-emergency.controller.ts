import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateStoreEmergencyDto } from './dto/create-store-emergency.dto';
import { UpdateStoreEmergencyReopeningDto } from './dto/update-store-emergency-reopening.dto';
import { StoreEmergencyService } from './store-emergency.service';

@Controller('integrations/store-emergencies')
@Permissions('integrations.emergencies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class StoreEmergencyController {
  constructor(private readonly service: StoreEmergencyService) {}

  @Get()
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.service.list(page, limit);
  }

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Permissions('integrations.emergencies.execute')
  create(@Body() dto: CreateStoreEmergencyDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch(':id/reopening')
  @Permissions('integrations.emergencies.execute')
  updateReopening(@Param('id') id: string, @Body() dto: UpdateStoreEmergencyReopeningDto) {
    return this.service.updateReopening(id, dto);
  }

  @Post(':id/restore')
  @Permissions('integrations.emergencies.execute')
  restoreNow(@Param('id') id: string) {
    return this.service.restoreNow(id);
  }

  @Post(':id/retry-failures')
  @Permissions('integrations.emergencies.execute')
  retryFailures(@Param('id') id: string) {
    return this.service.retryFailures(id);
  }
}
