import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { HandlersService } from './handlers.service';

@Controller('handlers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HandlersController {
  constructor(private handlersService: HandlersService) {}

  @Get()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  findAll() {
    return this.handlersService.findAll();
  }

  @Post()
  @Roles(AccountRole.super_admin)
  create(@Body('name') name: string) {
    return this.handlersService.create(name);
  }

  @Delete(':id')
  @Roles(AccountRole.super_admin)
  remove(@Param('id') id: string) {
    return this.handlersService.remove(id);
  }
}
