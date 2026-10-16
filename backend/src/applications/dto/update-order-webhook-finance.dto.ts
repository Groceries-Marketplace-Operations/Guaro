import { DidiOrderWebhookProfitMode } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateOrderWebhookFinanceDto {
  @IsOptional()
  @IsEnum(DidiOrderWebhookProfitMode)
  mode?: DidiOrderWebhookProfitMode | null;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/)
  value?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,10})?$/)
  nativeToMxnRate?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,10})?$/)
  mxnPerUsdRate?: string | null;
}
