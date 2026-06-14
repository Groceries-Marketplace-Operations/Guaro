import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { KaType, MenuIntegration, PaymentMode, PickingMode } from '@prisma/client';

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  brandName?: string;

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
