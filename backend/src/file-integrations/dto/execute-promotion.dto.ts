import { IsEnum, IsObject, IsString, IsUUID } from 'class-validator';
import { PromotionApiMode } from '@prisma/client';

export class ExecutePromotionDto {
  @IsUUID()
  brandId: string;

  @IsUUID()
  shopId: string;

  @IsEnum(PromotionApiMode)
  mode: PromotionApiMode;

  @IsObject()
  payload: Record<string, unknown>;
}
