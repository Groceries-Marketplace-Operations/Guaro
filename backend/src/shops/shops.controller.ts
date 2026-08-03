import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AccountRole, ShopStatus } from '@prisma/client';
import { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { CreateShopsBatchDto } from './dto/create-shops-batch.dto';
import { UpdateShopDto } from './dto/update-shop.dto';
import { ShopsService } from './shops.service';

@Controller('shops')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShopsController {
  constructor(private shopsService: ShopsService) {}

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('brandId') brandId?: string,
    @Query('status') status?: ShopStatus,
  ) {
    return this.shopsService.findAll({ page, limit, q, brandId, status });
  }

  @Get('import-template')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.bpo)
  downloadImportTemplate(@Res({ passthrough: true }) response: Response) {
    const generatedAt = new Date();
    const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="shop-import-template-${timestamp}.csv"`);
    return this.shopsService.generateImportTemplate();
  }

  @Get(':id')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findOne(@Param('id') id: string) {
    return this.shopsService.findOne(id);
  }

  @Post()
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.bpo)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateShopDto) {
    return this.shopsService.create(dto, u.id);
  }

  @Post('batch')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.bpo)
  createBatch(@CurrentUser() u: JwtUser, @Body() body: CreateShopsBatchDto) {
    return this.shopsService.createBatch(body.shops, u.id);
  }

  @Patch('batch-status')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.bpo)
  batchStatus(@Body() body: { ids: string[]; status: ShopStatus }) {
    return this.shopsService.batchUpdateStatus(body.ids, body.status);
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.bpo)
  update(@Param('id') id: string, @Body() dto: UpdateShopDto) {
    return this.shopsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.shopsService.remove(id);
  }

  @Post(':id/schedules')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  addSchedule(@Param('id') id: string, @Body() dto: CreateScheduleDto) {
    return this.shopsService.addSchedule(id, dto);
  }

  @Delete(':id/schedules/:scheduleId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeSchedule(@Param('id') id: string, @Param('scheduleId') scheduleId: string) {
    return this.shopsService.removeSchedule(id, scheduleId);
  }
}
