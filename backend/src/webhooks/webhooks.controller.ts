import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Permissions } from '../access-control/permissions.decorator';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
@Permissions('config.webhooks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Get()
  findAll() {
    return this.webhooksService.findAll();
  }

  @Post()
  @Permissions('config.webhooks.update')
  create(@Body() dto: CreateWebhookDto) {
    return this.webhooksService.create(dto);
  }

  @Patch(':id')
  @Permissions('config.webhooks.update')
  update(@Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    return this.webhooksService.update(id, dto);
  }

  @Delete(':id')
  @Permissions('config.webhooks.update')
  remove(@Param('id') id: string) {
    return this.webhooksService.remove(id);
  }
}
