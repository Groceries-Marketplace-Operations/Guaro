import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  nombre: string;

  @IsUrl()
  url: string;

  @IsOptional()
  @IsBoolean()
  esAlertas?: boolean;
}
