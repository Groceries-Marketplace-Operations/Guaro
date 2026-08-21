import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import {
  PutStoreOnboardingNotificationProfileDto,
  PutStoreOnboardingRolloutDto,
  UpdateStoreOnboardingControlDto,
} from './dto/store-onboarding-config.dto';
import {
  AssignStoreOnboardingConfigurationBriefDto,
  AssignStoreOnboardingUnitDto,
  AuditStoreOnboardingUnitDto,
  GoLiveStoreOnboardingDto,
  StoreOnboardingListQueryDto,
  StoreOnboardingTimelineQueryDto,
  SubmitStoreOnboardingShopIdsDto,
  TransitionStoreOnboardingUnitDto,
  UpdateStoreOnboardingBriefDto,
  UpdateStoreOnboardingChecklistDto,
} from './dto/store-onboarding-operation.dto';
import { StoreOnboardingConfigService } from './store-onboarding-config.service';
import { StoreOnboardingLifecycleService } from './store-onboarding-lifecycle.service';
import { StoreOnboardingService } from './store-onboarding.service';

@Controller('store-onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StoreOnboardingController {
  constructor(
    private readonly configService: StoreOnboardingConfigService,
    private readonly service: StoreOnboardingService,
    private readonly lifecycle: StoreOnboardingLifecycleService,
  ) {}

  @Get('status')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  status() {
    return this.configService.status();
  }

  @Get('config')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  config() {
    return this.configService.config();
  }

  @Put('config')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  updateConfig(@Body() dto: UpdateStoreOnboardingControlDto, @CurrentUser() user: JwtUser) {
    return this.configService.updateControl(dto, user);
  }

  @Get('rollouts')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  rollouts() {
    return this.configService.listRollouts();
  }

  @Put('rollouts')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  putRollout(@Body() dto: PutStoreOnboardingRolloutDto, @CurrentUser() user: JwtUser) {
    return this.configService.putRollout(dto, user);
  }

  @Get('notification-profiles')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  notificationProfiles() {
    return this.configService.listNotificationProfiles();
  }

  @Put('notification-profiles')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  putNotificationProfile(
    @Body() dto: PutStoreOnboardingNotificationProfileDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.configService.putNotificationProfile(dto, user);
  }

  @Get('notification-template-variables')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  notificationTemplateVariables() {
    return this.configService.notificationTemplateContract();
  }

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  list(@Query() query: StoreOnboardingListQueryDto, @CurrentUser() user: JwtUser) {
    return this.service.list(query, user);
  }

  @Get('assignee-options')
  @Permissions('system.manage')
  assigneeOptions(@CurrentUser() user: JwtUser) {
    return this.service.assigneeOptions(user);
  }

  @Get(':id')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.findOne(id, user);
  }

  @Get(':id/timeline')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  timeline(
    @Param('id') id: string,
    @Query() query: StoreOnboardingTimelineQueryDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.timeline(id, query, user);
  }

  @Get(':id/forecast')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  forecast(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.forecast(id, user);
  }

  @Post(':id/forecast/recalculate')
  @Permissions('system.manage')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  recalculateForecast(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.recalculateForecast(id, user);
  }

  @Post(':id/shop-ids')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  submitShopIds(
    @Param('id') id: string,
    @Body() dto: SubmitStoreOnboardingShopIdsDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.submitShopIds(id, dto, user);
  }

  @Patch(':id/configuration-brief')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  updateConfigurationBrief(
    @Param('id') id: string,
    @Body() dto: UpdateStoreOnboardingBriefDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.updateConfigurationBrief(id, dto, user);
  }

  @Patch(':id/configuration-brief-assignment')
  @Permissions('system.manage')
  assignConfigurationBrief(
    @Param('id') id: string,
    @Body() dto: AssignStoreOnboardingConfigurationBriefDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.assignConfigurationBrief(id, dto, user);
  }

  @Patch(':id/units/:unitId/checklist')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  updateChecklist(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: UpdateStoreOnboardingChecklistDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.updateChecklist(id, unitId, dto, user);
  }

  @Patch(':id/units/:unitId/assignment')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  assignUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: AssignStoreOnboardingUnitDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.assignUnit(id, unitId, dto, user);
  }

  @Post(':id/units/:unitId/transition')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  transitionUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: TransitionStoreOnboardingUnitDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.transitionUnit(id, unitId, dto, user);
  }

  @Post(':id/units/:unitId/audit')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  auditUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: AuditStoreOnboardingUnitDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.auditUnit(id, unitId, dto, user);
  }

  @Post(':id/go-live')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  goLive(@Param('id') id: string, @Body() dto: GoLiveStoreOnboardingDto, @CurrentUser() user: JwtUser) {
    return this.service.goLive(id, dto, user);
  }
}
