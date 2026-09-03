import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DidiOrderWebhookEventsService } from './didi-order-webhook-events.service';
import { OrderWebhookEventsQueryDto } from './dto/order-webhook-events-query.dto';

@Controller('applications/:applicationId/order-webhook/events')
@Roles(AccountRole.admin, AccountRole.super_admin)
@UseGuards(JwtAuthGuard, RolesGuard)
export class DidiOrderWebhookEventsController {
  constructor(private readonly events: DidiOrderWebhookEventsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  findAll(
    @Param('applicationId') applicationId: string,
    @Query() query: OrderWebhookEventsQueryDto,
  ) {
    return this.events.findAll(applicationId, query);
  }

  @Get(':eventId')
  @Header('Cache-Control', 'no-store')
  findOne(
    @Param('applicationId') applicationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.events.findOne(applicationId, eventId);
  }
}
