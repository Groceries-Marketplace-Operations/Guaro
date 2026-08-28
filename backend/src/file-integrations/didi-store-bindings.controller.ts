import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { DidiStoreBindingsAdminGuard } from './didi-store-bindings-admin.guard';
import { DidiStoreBindingsService } from './didi-store-bindings.service';
import { DidiStoreBindingExecutionsService } from './didi-store-binding-executions.service';
import {
  BindDidiStoresDto,
  CreateDidiStoreBindingExecutionDto,
  GetDidiStoreBindingExecutionDto,
  ListDidiBoundStoresDto,
  ListDidiLocalStoresDto,
  ListDidiStoreBindingExecutionsDto,
  SelectDidiLocalStoresDto,
  UnbindDidiStoresDto,
} from './dto/didi-store-binding.dto';

@Controller('integrations/didi-store-bindings')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard, DidiStoreBindingsAdminGuard)
export class DidiStoreBindingsController {
  constructor(
    private readonly service: DidiStoreBindingsService,
    private readonly executions: DidiStoreBindingExecutionsService,
    private readonly permissionAccess: PermissionAccessService,
  ) {}

  @Get('shops')
  async shops(@Query() dto: ListDidiBoundStoresDto, @CurrentUser() user: JwtUser) {
    const executePermissionAllowed = await this.permissionAccess.can(user, ['integrations.custom.execute']);
    return this.service.listBoundStores(dto, user.roles, executePermissionAllowed);
  }

  @Get('local-shops')
  async localShops(@Query() dto: ListDidiLocalStoresDto, @CurrentUser() user: JwtUser) {
    const executePermissionAllowed = await this.permissionAccess.can(user, ['integrations.custom.execute']);
    return this.service.listLocalStores(dto, user.roles, executePermissionAllowed);
  }

  @Get('local-shops/selection')
  async localShopSelection(@Query() dto: SelectDidiLocalStoresDto, @CurrentUser() user: JwtUser) {
    const executePermissionAllowed = await this.permissionAccess.can(user, ['integrations.custom.execute']);
    return this.service.selectLocalStores(dto.applicationId, dto.q, user.roles, executePermissionAllowed);
  }

  @Get('executions')
  executionsList(@Query() dto: ListDidiStoreBindingExecutionsDto) {
    return this.executions.list(dto);
  }

  @Get('executions/:id')
  executionDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() dto: GetDidiStoreBindingExecutionDto,
  ) {
    return this.executions.detail(id, dto);
  }

  @Post('executions')
  @Permissions('integrations.custom.execute')
  createExecution(@Body() dto: CreateDidiStoreBindingExecutionDto, @CurrentUser() user: JwtUser) {
    return this.executions.create(dto, user.id, user.roles);
  }

  @Post('executions/:id/cancel')
  @Permissions('integrations.custom.execute')
  cancelExecution(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.executions.cancel(id, user.id);
  }

  @Post('bind')
  @Permissions('integrations.custom.execute')
  bind(@Body() dto: BindDidiStoresDto, @CurrentUser() user: JwtUser) {
    return this.service.bind(dto, user.id, user.roles);
  }

  @Post('unbind')
  @Permissions('integrations.custom.execute')
  unbind(@Body() dto: UnbindDidiStoresDto, @CurrentUser() user: JwtUser) {
    return this.service.unbind(dto, user.id, user.roles);
  }
}
