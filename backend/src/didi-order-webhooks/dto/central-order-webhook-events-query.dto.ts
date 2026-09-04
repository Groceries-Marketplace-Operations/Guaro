import { IsOptional, IsUUID } from 'class-validator';
import { OrderWebhookEventsQueryDto } from './order-webhook-events-query.dto';

export class CentralOrderWebhookEventsQueryDto extends OrderWebhookEventsQueryDto {
  @IsOptional()
  @IsUUID()
  applicationId?: string;
}
