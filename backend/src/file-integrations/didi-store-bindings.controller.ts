import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { DidiStoreBindingsAdminGuard } from './didi-store-bindings-admin.guard';
import { DidiStoreBindingsService } from './didi-store-bindings.service';
import { BindDidiStoresDto, ListDidiBoundStoresDto, UnbindDidiStoresDto } from './dto/didi-store-binding.dto';

@Controller('integrations/didi-store-bindings')
@Permissions('integrations.custom')
@UseGuards(JwtAuthGuard, RolesGuard, DidiStoreBindingsAdminGuard)
export class DidiStoreBindingsController {
  constructor(
    private readonly service: DidiStoreBindingsService,
    private readonly permissionAccess: PermissionAccessService,
  ) {}

  @Get('shops')
  async shops(@Query() dto: ListDidiBoundStoresDto, @CurrentUser() user: JwtUser) {
    const executePermissionAllowed = await this.permissionAccess.can(user, ['integrations.custom.execute']);
    return this.service.listBoundStores(dto, user.roles, executePermissionAllowed);
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
