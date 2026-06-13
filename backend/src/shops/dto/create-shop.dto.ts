import { IsDecimal, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ShopStatus } from '@prisma/client';

export class CreateShopDto {
  @IsString()
  shopId: string;

  @IsString()
  appShopId: string;

  @IsUUID()
  brandId: string;

  @IsOptional()
  @IsDecimal()
  latitude?: string;

  @IsOptional()
  @IsDecimal()
  longitude?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsEnum(ShopStatus)
  status?: ShopStatus;
}
