import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole, Country } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

@Controller('applications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApplicationsController {
  constructor(private applicationsService: ApplicationsService) {}

  @Get()
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('country') country?: Country,
  ) {
    return this.applicationsService.findAll({ page, limit, q, country });
  }

  @Get(':id')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  findOne(@Param('id') id: string) {
    return this.applicationsService.findOne(id);
  }

  @Post()
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateApplicationDto) {
    return this.applicationsService.create(dto, u.id);
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.applicationsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.applicationsService.remove(id);
  }
}
