import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsBoolean()
  isAlerts?: boolean;
}
