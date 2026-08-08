import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
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
import { Permissions } from '../access-control/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { AutoTurnOffService } from './auto-turn-off.service';
import { CreateAutoTurnOffPoolDto } from './dto/create-auto-turn-off-pool.dto';
import { UpdateAutoTurnOffPoolDto } from './dto/update-auto-turn-off-pool.dto';
import { CreateAutoTurnOffRuleDto } from './dto/create-auto-turn-off-rule.dto';
import { UpdateAutoTurnOffRuleDto } from './dto/update-auto-turn-off-rule.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
@Controller('integrations/auto-turn-off')
@Permissions('integrations.auto_turn_off')
export class AutoTurnOffController {
  constructor(private readonly service: AutoTurnOffService) {}

  @Get('pools')
  listPools() {
    return this.service.listPools();
  }

  @Post('pools')
  @Permissions('integrations.auto_turn_off.configure')
  createPool(@Body() dto: CreateAutoTurnOffPoolDto) {
    return this.service.createPool(dto);
  }

  @Patch('pools/:id')
  @Permissions('integrations.auto_turn_off.configure')
  updatePool(@Param('id') id: string, @Body() dto: UpdateAutoTurnOffPoolDto) {
    return this.service.updatePool(id, dto);
  }

  @Delete('pools/:id')
  @Permissions('integrations.auto_turn_off.configure')
  removePool(@Param('id') id: string) {
    return this.service.removePool(id);
  }

  @Post('pools/:poolId/rules')
  @Permissions('integrations.auto_turn_off.configure')
  createRule(
    @Param('poolId') poolId: string,
    @Body() dto: CreateAutoTurnOffRuleDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.createRule(poolId, dto, user.id);
  }

  @Patch('rules/:id')
  @Permissions('integrations.auto_turn_off.configure')
  updateRule(@Param('id') id: string, @Body() dto: UpdateAutoTurnOffRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.updateRule(id, dto, user.id);
  }

  @Delete('rules/:id')
  @Permissions('integrations.auto_turn_off.configure')
  removeRule(@Param('id') id: string) {
    return this.service.removeRule(id);
  }

  @Post('rules/:id/run')
  @Permissions('integrations.auto_turn_off.execute')
  runRule(@Param('id') id: string) {
    return this.service.runRuleNow(id);
  }

  @Post('rules/:id/stop')
  @Permissions('integrations.auto_turn_off.execute')
  stopRule(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.stopRule(id, user.id);
  }

  @Get('pools/:id/executions')
  executions(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.service.listExecutions(id, page, limit);
  }

  @Get('executions/:id/shops')
  executionShops(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.service.listExecutionShops(id, page, limit, status);
  }
}
