import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  name: string;

  @IsUrl()
  url: string;

  @IsOptional()
  @IsBoolean()
  isAlerts?: boolean;
}
