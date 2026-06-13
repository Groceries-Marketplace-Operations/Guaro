import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { HandlersService } from './handlers.service';

@Controller('handlers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HandlersController {
  constructor(private handlersService: HandlersService) {}

  @Get()
  @Roles(AccountRol.admin, AccountRol.super_admin)
  findAll() {
    return this.handlersService.findAll();
  }

  @Post()
  @Roles(AccountRol.super_admin)
  create(@Body('nombre') nombre: string) {
    return this.handlersService.create(nombre);
  }

  @Delete(':id')
  @Roles(AccountRol.super_admin)
  remove(@Param('id') id: string) {
    return this.handlersService.remove(id);
  }
}
