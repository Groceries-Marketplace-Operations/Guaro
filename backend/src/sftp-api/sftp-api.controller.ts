import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Permissions } from '../access-control/permissions.decorator';
import { Delete } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { SftpApiDto, SftpApiRunDto } from './sftp-api.dto';
import { SftpApiService } from './sftp-api.service';

@Controller('integrations/sftp-api')
@UseGuards(JwtAuthGuard, RolesGuard)
@Permissions('integrations.sftp_api')
export class SftpApiController {
  constructor(private readonly service: SftpApiService) {}
  @Get('brands/options') brands(@Query('q') q?: string) { return this.service.brandOptions((q ?? '').slice(0, 100)); }
  @Get('applications/options') @Permissions('integrations.sftp_api.configure')
  applications(@Query('brandId', ParseUUIDPipe) brandId: string) { return this.service.applicationOptions(brandId); }
  @Get() list() { return this.service.list(); }
  @Get(':id') detail(@Param('id', ParseUUIDPipe) id: string) { return this.service.detail(id); }
  @Post() @Permissions('integrations.sftp_api.configure')
  create(@Body() dto: SftpApiDto, @CurrentUser() user: JwtUser) { return this.service.save(dto, user.id); }
  @Patch(':id') @Permissions('integrations.sftp_api.configure')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SftpApiDto, @CurrentUser() user: JwtUser) { return this.service.save(dto, user.id, id); }
  @Post(':id/run') @Permissions('integrations.sftp_api.execute')
  run(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SftpApiRunDto, @CurrentUser() user: JwtUser) { return this.service.run(id, dto.mode, user.id); }
  @Get(':id/runs')
  history(@Param('id', ParseUUIDPipe) id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) { return this.service.history(id, Math.max(1, page)); }
  @Get(':id/files')
  files(@Param('id', ParseUUIDPipe) id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('runId', new ParseUUIDPipe({ optional: true })) runId?: string) { return this.service.processedFiles(id, Math.max(1, page), runId); }
  @Delete(':id/files') @Permissions('integrations.sftp_api.configure')
  forgetAll(@Param('id', ParseUUIDPipe) id: string, @Query('runId', new ParseUUIDPipe({ optional: true })) runId?: string) { return this.service.forgetProcessedFiles(id, undefined, runId); }
  @Delete(':id/files/:fileId') @Permissions('integrations.sftp_api.configure')
  forget(@Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Query('runId', new ParseUUIDPipe({ optional: true })) runId?: string) { return this.service.forgetProcessedFiles(id, fileId, runId); }
  @Get('runs/:id/uploads')
  uploads(@Param('id', ParseUUIDPipe) id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) { return this.service.uploads(id, Math.max(1, page)); }
  @Get('uploads/:id/payload')
  upload(@Param('id', ParseUUIDPipe) id: string) { return this.service.upload(id); }
}
