import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { DidiOrderWebhooksService } from './didi-order-webhooks.service';

@Controller('didi-order-webhooks')
export class DidiOrderWebhooksController {
  constructor(private readonly didiOrderWebhooks: DidiOrderWebhooksService) {}

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  receive(
    @Param('token') token: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    return this.didiOrderWebhooks.receive(token, request.rawBody);
  }
}
