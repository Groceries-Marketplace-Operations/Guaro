import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SectionsService } from './sections.service';

@Controller('sections')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SectionsController {
  constructor(private sectionsService: SectionsService) {}

  @Get()
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findAll() {
    return this.sectionsService.findAll();
  }

  @Post()
  @Roles(AccountRol.super_admin)
  create(@Body('nombre') nombre: string) {
    return this.sectionsService.create(nombre);
  }

  @Patch(':id')
  @Roles(AccountRol.super_admin)
  update(@Param('id') id: string, @Body('nombre') nombre: string) {
    return this.sectionsService.update(id, nombre);
  }
}
