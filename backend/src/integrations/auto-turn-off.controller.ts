import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { AutoTurnOffService } from './auto-turn-off.service';
import { CreateAutoTurnOffPoolDto } from './dto/create-auto-turn-off-pool.dto';
import { UpdateAutoTurnOffPoolDto } from './dto/update-auto-turn-off-pool.dto';
import { CreateAutoTurnOffRuleDto } from './dto/create-auto-turn-off-rule.dto';
import { UpdateAutoTurnOffRuleDto } from './dto/update-auto-turn-off-rule.dto';

function assertAccess(user: JwtUser) {
  const allowed = user.roles.includes(AccountRole.super_admin)
    || (user.roles.includes(AccountRole.admin) && (user.adminModules ?? []).includes('integrations'));
  if (!allowed) throw new ForbiddenException();
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
@Controller('integrations/auto-turn-off')
export class AutoTurnOffController {
  constructor(private readonly service: AutoTurnOffService) {}

  @Get('pools')
  listPools(@CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.listPools();
  }

  @Post('pools')
  createPool(@Body() dto: CreateAutoTurnOffPoolDto, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.createPool(dto);
  }

  @Patch('pools/:id')
  updatePool(@Param('id') id: string, @Body() dto: UpdateAutoTurnOffPoolDto, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.updatePool(id, dto);
  }

  @Delete('pools/:id')
  removePool(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.removePool(id);
  }

  @Post('pools/:poolId/rules')
  createRule(
    @Param('poolId') poolId: string,
    @Body() dto: CreateAutoTurnOffRuleDto,
    @CurrentUser() user: JwtUser,
  ) {
    assertAccess(user);
    return this.service.createRule(poolId, dto);
  }

  @Patch('rules/:id')
  updateRule(@Param('id') id: string, @Body() dto: UpdateAutoTurnOffRuleDto, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  removeRule(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.removeRule(id);
  }

  @Post('rules/:id/run')
  runRule(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    assertAccess(user);
    return this.service.runRuleNow(id);
  }

  @Get('pools/:id/executions')
  executions(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    assertAccess(user);
    return this.service.listExecutions(id, page, limit);
  }
}
