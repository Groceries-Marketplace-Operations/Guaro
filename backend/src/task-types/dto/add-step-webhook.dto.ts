import { IsArray, IsEnum, IsUUID } from 'class-validator';
import { WebhookEvento } from '@prisma/client';

export class AddStepWebhookDto {
  @IsUUID()
  webhookId: string;

  @IsArray()
  @IsEnum(WebhookEvento, { each: true })
  eventos: WebhookEvento[];
}
