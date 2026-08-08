import { Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { ExecutePromotionDto } from './dto/execute-promotion.dto';
import { PromotionApiService } from './promotion-api.service';

@Controller('integrations/promotion-api')
@Permissions('integrations.promotion_api')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class PromotionApiController {
  constructor(private readonly service: PromotionApiService) {}

  @Get('contract')
  contract() { return this.service.contract(); }

  @Post('execute')
  execute(@Body() dto: ExecutePromotionDto, @CurrentUser() user: JwtUser) {
    return this.service.execute(dto, user.id);
  }

  @Get('executions')
  executions(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.service.executions(page);
  }
}
