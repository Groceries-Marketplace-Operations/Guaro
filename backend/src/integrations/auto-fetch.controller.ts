import { BadRequestException, Body, Controller, DefaultValuePipe, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AutoFetchKind } from '@prisma/client';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { AutoFetchService } from './auto-fetch.service';
import { UpdateAutoFetchPoolDto } from './dto/update-auto-fetch-pool.dto';
import { AddAutoFetchBrandDto } from './dto/add-auto-fetch-brand.dto';
import { UpdateAutoFetchBrandDto } from './dto/update-auto-fetch-brand.dto';

@Controller('integrations/auto-fetch')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AutoFetchController {
  constructor(
    private readonly service: AutoFetchService,
    private readonly permissionAccess: PermissionAccessService,
  ) {}

  @Get(':kind/pools')
  async list(@Param('kind') kind: string, @CurrentUser() user: JwtUser) {
    if (!Object.values(AutoFetchKind).includes(kind as AutoFetchKind)) throw new BadRequestException('Invalid auto fetch kind');
    await this.assertKindAccess(user, kind as AutoFetchKind);
    return this.service.list(kind as AutoFetchKind);
  }

  @Patch('pools/:id')
  async update(@Param('id') id: string, @Body() dto: UpdateAutoFetchPoolDto, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'configure');
    return this.service.update(id, dto);
  }

  @Post('pools/:id/run')
  async run(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'execute');
    return this.service.runNow(id);
  }

  @Post('pools/:id/stop')
  async stop(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'execute');
    return this.service.stopPool(id);
  }

  @Post('pools/:id/brands')
  async addCkaBrand(@Param('id') id: string, @Body() dto: AddAutoFetchBrandDto, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'configure');
    return this.service.addCkaBrand(id, dto.brandId);
  }

  @Delete('pools/:id/brands/:brandId')
  async removeCkaBrand(@Param('id') id: string, @Param('brandId') brandId: string, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'configure');
    return this.service.removeCkaBrand(id, brandId);
  }

  @Patch('pools/:id/brands/:brandId')
  async updateBrand(
    @Param('id') id: string,
    @Param('brandId') brandId: string,
    @Body() dto: UpdateAutoFetchBrandDto,
    @CurrentUser() user: JwtUser,
  ) {
    await this.assertPoolAccess(user, id, 'configure');
    return this.service.updateBrand(id, brandId, dto.active);
  }

  @Post('pools/:id/brands/:brandId/run')
  async runBrand(@Param('id') id: string, @Param('brandId') brandId: string, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'execute');
    return this.service.runBrand(id, brandId);
  }

  @Post('pools/:id/brands/:brandId/stop')
  async stopBrand(@Param('id') id: string, @Param('brandId') brandId: string, @CurrentUser() user: JwtUser) {
    await this.assertPoolAccess(user, id, 'execute');
    return this.service.stopBrand(id, brandId);
  }

  @Get('pools/:id/executions')
  async executions(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @CurrentUser() user: JwtUser,
  ) {
    await this.assertPoolAccess(user, id);
    return this.service.executions(id, page);
  }

  private async assertPoolAccess(user: JwtUser, poolId: string, action: 'view' | 'configure' | 'execute' = 'view') {
    const pool = await this.service.findOne(poolId);
    await this.assertKindAccess(user, pool.kind, action);
  }

  private async assertKindAccess(user: JwtUser, kind: AutoFetchKind, action: 'view' | 'configure' | 'execute' = 'view') {
    const basePermission = kind === AutoFetchKind.stores
      ? 'integrations.auto_stores_fetch'
      : 'integrations.auto_menu_fetch';
    const permission = action === 'view' ? basePermission : `${basePermission}.${action}`;
    if (!(await this.permissionAccess.can(user, [permission]))) {
      throw new ForbiddenException('You do not have permission to access this auto-fetch integration');
    }
  }
}
