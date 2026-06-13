import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsBoolean()
  esAlertas?: boolean;
}
