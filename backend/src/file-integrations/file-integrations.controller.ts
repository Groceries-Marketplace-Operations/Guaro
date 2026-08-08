import { BadRequestException, Body, Controller, DefaultValuePipe, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole, FileIntegrationKind } from '@prisma/client';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertFileIntegrationRuleDto } from './dto/upsert-file-integration-rule.dto';
import { FileIntegrationsService } from './file-integrations.service';

@Controller('integrations/file-integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class FileIntegrationsController {
  constructor(
    private readonly service: FileIntegrationsService,
    private readonly prisma: PrismaService,
    private readonly permissionAccess: PermissionAccessService,
  ) {}

  @Get('rules/:kind')
  async list(@Param('kind') value: string, @CurrentUser() user: JwtUser) {
    const kind = value as FileIntegrationKind;
    if (!Object.values(FileIntegrationKind).includes(kind)) throw new BadRequestException('Invalid integration kind');
    await this.assertKindAccess(user, kind);
    return this.service.list(kind);
  }

  @Post('rules')
  async create(@Body() dto: UpsertFileIntegrationRuleDto, @CurrentUser() user: JwtUser) {
    await this.assertKindAccess(user, dto.kind, 'configure');
    return this.service.create(dto, user.id);
  }

  @Patch('rules/:id')
  async update(@Param('id') id: string, @Body() dto: UpsertFileIntegrationRuleDto, @CurrentUser() user: JwtUser) {
    await this.assertRuleAccess(user, id, 'configure');
    await this.assertKindAccess(user, dto.kind, 'configure');
    return this.service.update(id, dto);
  }

  @Delete('rules/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.assertRuleAccess(user, id, 'configure');
    return this.service.remove(id);
  }

  @Post('rules/:id/run')
  async run(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.assertRuleAccess(user, id, 'execute');
    return this.service.run(id, user.id);
  }

  @Post('rules/:id/stop')
  async stop(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.assertRuleAccess(user, id, 'execute');
    return this.service.stop(id);
  }

  @Get('rules/:id/executions')
  async executions(@Param('id') id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @CurrentUser() user: JwtUser) {
    await this.assertRuleAccess(user, id);
    return this.service.executions(id, page);
  }

  @Get('executions/:executionId/files/:fileName')
  async download(@Param('executionId') executionId: string, @Param('fileName') fileName: string, @CurrentUser() user: JwtUser) {
    const execution = await this.prisma.fileIntegrationExecution.findUnique({
      where: { id: executionId },
      select: { rule: { select: { kind: true, deletedAt: true } } },
    });
    if (!execution?.rule || execution.rule.deletedAt) throw new BadRequestException('Integration execution not found');
    await this.assertKindAccess(user, execution.rule.kind);
    return this.service.download(executionId, fileName);
  }

  private async assertRuleAccess(user: JwtUser, ruleId: string, action: 'view' | 'configure' | 'execute' = 'view') {
    const rule = await this.prisma.fileIntegrationRule.findFirst({
      where: { id: ruleId, deletedAt: null },
      select: { kind: true },
    });
    if (!rule) throw new BadRequestException('File integration rule not found');
    await this.assertKindAccess(user, rule.kind, action);
  }

  private async assertKindAccess(user: JwtUser, kind: FileIntegrationKind, action: 'view' | 'configure' | 'execute' = 'view') {
    const basePermission = kind === FileIntegrationKind.complex_promotion_reader
      ? 'integrations.promotions_sftp'
      : 'integrations.custom';
    const permission = action === 'view' ? basePermission : `${basePermission}.${action}`;
    if (!(await this.permissionAccess.can(user, [permission]))) {
      throw new ForbiddenException('You do not have permission to access this file integration');
    }
  }
}
