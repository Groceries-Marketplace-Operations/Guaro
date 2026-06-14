import { IsArray, IsEnum, IsString } from 'class-validator';
import { WebhookEvent } from '@prisma/client';

export class AddStepWebhookDto {
  @IsString()
  webhookId: string;

  @IsArray()
  @IsEnum(WebhookEvent, { each: true })
  events: WebhookEvent[];
}
