import {
  Body,
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { ApplicationShopInventoryService } from './application-shop-inventory.service';
import { AddApplicationShopInventoryDto } from './dto/application-shop-inventory.dto';

@Controller('admin/app-shop-inventory')
@Roles(AccountRole.super_admin)
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApplicationShopInventoryController {
  constructor(private readonly service: ApplicationShopInventoryService) {}

  @Get('options')
  options(@Query('q') q?: string) {
    return this.service.applicationOptions(q);
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  add(@CurrentUser() user: JwtUser, @Body() dto: AddApplicationShopInventoryDto) {
    return this.service.add(dto.applicationId, user.id);
  }

  @Post(':id/fetch')
  @HttpCode(202)
  fetch(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestFetch(id, user.id);
  }

  @Get(':id/brands')
  brands(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.brands(id);
  }

  @Get(':id/shops')
  shops(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('brand') brand?: string,
  ) {
    if (page < 1) throw new BadRequestException('page must be at least 1');
    return this.service.shops(id, { page, limit, q, brand });
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id, user.id);
  }
}
