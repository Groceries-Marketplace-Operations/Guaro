import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { Country, KaType, MenuIntegration, PaymentMode, PickingMode } from '@prisma/client';

export class CreateBrandDto {
  @IsString()
  brandId: string;

  @IsString()
  brandName: string;

  @IsEnum(Country)
  country: Country;

  @IsEnum(KaType)
  kaType: KaType;

  @IsOptional()
  @IsString()
  category?: string;

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
  applicationId?: string;
}
