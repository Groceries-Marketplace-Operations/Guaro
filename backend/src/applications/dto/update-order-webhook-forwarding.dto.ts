import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOrderWebhookForwardingDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  url?: string;
}
