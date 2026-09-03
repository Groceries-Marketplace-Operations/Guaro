import { Type } from 'class-transformer';
import { DidiOrderWebhookRequestOutcome } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
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
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
