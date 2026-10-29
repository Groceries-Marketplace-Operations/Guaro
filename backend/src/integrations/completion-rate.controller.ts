import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { CompletionRateService } from './completion-rate.service';
import { UpdateCompletionRateDto } from './dto/update-completion-rate.dto';

@Controller('integrations/completion-rate')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompletionRateController {
  constructor(private readonly service: CompletionRateService, private readonly permissions: PermissionAccessService) {}
  private async access(user: JwtUser, configure = false) {
    if (!await this.permissions.can(user, [configure ? 'integrations.completion_rate.configure' : 'integrations.completion_rate'])) throw new ForbiddenException();
  }
  @Get()
  async list(@CurrentUser() user: JwtUser) {
    await this.access(user);
    return this.service.list();
  }
  @Patch(':brandId')
  async update(@Param('brandId', ParseUUIDPipe) id: string, @Body() dto: UpdateCompletionRateDto, @CurrentUser() user: JwtUser) {
    await this.access(user, true);
    return this.service.update(id, dto);
  }
  @Get(':brandId/history')
  async history(@Param('brandId', ParseUUIDPipe) id: string, @CurrentUser() user: JwtUser) {
    await this.access(user);
    return this.service.history(id);
  }
  @Get(':brandId/store-history')
  async storeHistory(@Param('brandId', ParseUUIDPipe) id: string, @CurrentUser() user: JwtUser) {
    await this.access(user);
    return this.service.storeHistory(id);
  }
}
