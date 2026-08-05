import { BadRequestException, Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole, FileIntegrationKind } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { UpsertFileIntegrationRuleDto } from './dto/upsert-file-integration-rule.dto';
import { FileIntegrationsService } from './file-integrations.service';

@Controller('integrations/file-integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class FileIntegrationsController {
  constructor(private readonly service: FileIntegrationsService) {}

  @Get('rules/:kind')
  list(@Param('kind') value: string) {
    const kind = value as FileIntegrationKind;
    if (!Object.values(FileIntegrationKind).includes(kind)) throw new BadRequestException('Invalid integration kind');
    return this.service.list(kind);
  }

  @Post('rules')
  create(@Body() dto: UpsertFileIntegrationRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch('rules/:id')
  update(@Param('id') id: string, @Body() dto: UpsertFileIntegrationRuleDto) {
    return this.service.update(id, dto);
  }

  @Delete('rules/:id')
  remove(@Param('id') id: string) { return this.service.remove(id); }

  @Post('rules/:id/run')
  run(@Param('id') id: string, @CurrentUser() user: JwtUser) { return this.service.run(id, user.id); }

  @Post('rules/:id/stop')
  stop(@Param('id') id: string) { return this.service.stop(id); }

  @Get('rules/:id/executions')
  executions(@Param('id') id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.service.executions(id, page);
  }

  @Get('executions/:executionId/files/:fileName')
  download(@Param('executionId') executionId: string, @Param('fileName') fileName: string) {
    return this.service.download(executionId, fileName);
  }
}
