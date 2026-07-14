import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { KaType, MenuIntegration, PaymentMode, PickingMode } from '@prisma/client';

export class UpdateBrandDto {
  // Immutable fields — accepted to avoid validation errors but never written to DB
  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  brandName?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(KaType)
  kaType?: KaType;

  @IsOptional()
  @IsEnum(MenuIntegration)
  menuIntegration?: MenuIntegration;

  @IsOptional()
  @IsEnum(PickingMode)
  pickingMode?: PickingMode;

  @IsOptional()
  @IsEnum(PaymentMode)
  paymentMode?: PaymentMode;

  @IsOptional()
  @IsUUID()
  applicationId?: string | null;

  @IsOptional()
  @IsUUID()
  ownerId?: string | null;
}
