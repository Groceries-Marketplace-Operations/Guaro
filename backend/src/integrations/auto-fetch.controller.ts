import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole, AutoFetchKind } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AutoFetchService } from './auto-fetch.service';
import { UpdateAutoFetchPoolDto } from './dto/update-auto-fetch-pool.dto';

@Controller('integrations/auto-fetch')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class AutoFetchController {
  constructor(private readonly service: AutoFetchService) {}

  @Get(':kind/pools')
  list(@Param('kind') kind: string) {
    if (!Object.values(AutoFetchKind).includes(kind as AutoFetchKind)) throw new BadRequestException('Invalid auto fetch kind');
    return this.service.list(kind as AutoFetchKind);
  }

  @Patch('pools/:id')
  update(@Param('id') id: string, @Body() dto: UpdateAutoFetchPoolDto) {
    return this.service.update(id, dto);
  }

  @Post('pools/:id/run')
  run(@Param('id') id: string) {
    return this.service.runNow(id);
  }

  @Get('pools/:id/executions')
  executions(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.service.executions(id, page);
  }
}
