import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Permissions } from '../access-control/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { UpsertOfferMenuUploadRuleDto } from './dto/upsert-offer-menu-upload-rule.dto';
import { OfferMenuUploadService } from './offer-menu-upload.service';

@Controller('integrations/offer-menu-upload')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OfferMenuUploadController {
  constructor(private readonly service: OfferMenuUploadService) {}

  @Get('rules')
  @Permissions('integrations.custom')
  list() {
    return this.service.list();
  }

  @Post('rules')
  @Permissions('integrations.custom.configure')
  create(@Body() dto: UpsertOfferMenuUploadRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.create(dto, user.id);
  }

  @Patch('rules/:id')
  @Permissions('integrations.custom.configure')
  update(@Param('id') id: string, @Body() dto: UpsertOfferMenuUploadRuleDto, @CurrentUser() user: JwtUser) {
    return this.service.update(id, dto, user.id);
  }

  @Delete('rules/:id')
  @Permissions('integrations.custom.configure')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('rules/:id/run')
  @Permissions('integrations.custom.execute')
  run(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.run(id, user.id);
  }

  @Post('rules/:id/stop')
  @Permissions('integrations.custom.execute')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
}
