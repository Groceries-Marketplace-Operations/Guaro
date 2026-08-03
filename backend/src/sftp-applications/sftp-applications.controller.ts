import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { CreateSftpApplicationDto } from './dto/create-sftp-application.dto';
import { UpdateSftpApplicationDto } from './dto/update-sftp-application.dto';
import { SftpApplicationsService } from './sftp-applications.service';

@Controller('sftp-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class SftpApplicationsController {
  constructor(private readonly service: SftpApplicationsService) {}

  @Get()
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('q') q?: string,
  ) {
    return this.service.list({ page, limit, q });
  }

  @Post()
  create(@Body() dto: CreateSftpApplicationDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSftpApplicationDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
