import { Transform, Type } from 'class-transformer';
import { Country, DidiOrderWebhookRequestOutcome, DidiOrderWebhookRequestStage } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';

export class OrderWebhookEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsEnum(DidiOrderWebhookRequestOutcome)
  status?: DidiOrderWebhookRequestOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  appShopId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/)
  orderId?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/)
  didiShopId?: string;

  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @IsOptional()
  @IsEnum(DidiOrderWebhookRequestStage)
  stage?: DidiOrderWebhookRequestStage;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}(?:\.\d{1,2})?$/)
  minOrderAmount?: string;

  @IsOptional()
  @IsIn(['order_price', 'real_price', 'real_pay_price'])
  amountField?: 'order_price' | 'real_price' | 'real_pay_price';

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}(?:\.\d{1,2})?$/)
  maxOrderAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}(?:\.\d{1,4})?$/)
  minProfitMxn?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}(?:\.\d{1,4})?$/)
  maxProfitMxn?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  hasProfit?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600_000)
  minDurationMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600_000)
  maxDurationMs?: number;

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
