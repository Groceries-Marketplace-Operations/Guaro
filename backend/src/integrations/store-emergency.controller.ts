import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateStoreEmergencyDto } from './dto/create-store-emergency.dto';
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

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateStoreEmergencyDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Post(':id/restore')
  restoreNow(@Param('id') id: string) {
    return this.service.restoreNow(id);
  }
}
