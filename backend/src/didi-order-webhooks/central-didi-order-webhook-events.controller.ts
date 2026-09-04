import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Permissions } from '../access-control/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CentralOrderWebhookEventsQueryDto } from './dto/central-order-webhook-events-query.dto';
import { DidiOrderWebhookEventsService } from './didi-order-webhook-events.service';

@Controller('order-webhook/events')
@Permissions('applications.update')
@Roles(AccountRole.admin, AccountRole.super_admin)
@UseGuards(JwtAuthGuard, RolesGuard)
export class CentralDidiOrderWebhookEventsController {
  constructor(private readonly events: DidiOrderWebhookEventsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  findAll(@Query() query: CentralOrderWebhookEventsQueryDto) {
    return this.events.findAllGlobal(query);
  }

  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  findOne(
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
  ) {
    return this.events.findOneGlobal(requestId);
  }
}
