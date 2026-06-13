import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { UpdateShopDto } from './dto/update-shop.dto';
import { ShopsService } from './shops.service';

@Controller('shops')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShopsController {
  constructor(private shopsService: ShopsService) {}

  @Get()
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findAll(@Query('brandId') brandId?: string) {
    return this.shopsService.findAll(brandId);
  }

  @Get(':id')
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findOne(@Param('id') id: string) {
    return this.shopsService.findOne(id);
  }

  @Post()
  @Roles(AccountRol.admin, AccountRol.super_admin)
  create(@CurrentUser() u: any, @Body() dto: CreateShopDto) {
    return this.shopsService.create(dto, u.id);
  }

  @Patch(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.bpo)
  update(@Param('id') id: string, @Body() dto: UpdateShopDto) {
    return this.shopsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  remove(@Param('id') id: string) {
    return this.shopsService.remove(id);
  }

  @Post(':id/schedules')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  addSchedule(@Param('id') id: string, @Body() dto: CreateScheduleDto) {
    return this.shopsService.addSchedule(id, dto);
  }

  @Delete(':id/schedules/:scheduleId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeSchedule(@Param('id') id: string, @Param('scheduleId') scheduleId: string) {
    return this.shopsService.removeSchedule(id, scheduleId);
  }
}
