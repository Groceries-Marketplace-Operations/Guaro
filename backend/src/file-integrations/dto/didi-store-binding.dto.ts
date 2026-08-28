import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DIDI_BIND_MAX_SHOPS, DIDI_UNBIND_MAX_SHOPS } from '../didi-store-bindings.util';

export class DidiBindShopDto {
  @IsString({ message: 'shopId must be a string so its int64 value remains exact' })
  @Matches(/^57\d{17}$/, { message: 'shopId must be a 19-digit DiDi shop_id beginning with 57' })
  shopId!: string;

  @IsString()
  @Length(1, 128)
  appShopId!: string;
}

export class DidiUnbindShopDto {
  @IsString({ message: 'shopId must be a string so its int64 value remains exact' })
  @Matches(/^57\d{17}$/, { message: 'shopId must be a 19-digit DiDi shop_id beginning with 57' })
  shopId!: string;

  @IsString()
  @Length(1, 128)
  appShopId!: string;
}

export class BindDidiStoresDto {
  @IsUUID()
  applicationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DIDI_BIND_MAX_SHOPS)
  @ValidateNested({ each: true })
  @Type(() => DidiBindShopDto)
  shops!: DidiBindShopDto[];

  @IsString()
  confirmation!: string;

  @IsOptional()
  @IsString()
  @Length(10, 500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  productionAcknowledged?: boolean;
}

export class UnbindDidiStoresDto {
  @IsUUID()
  applicationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DIDI_UNBIND_MAX_SHOPS)
  @ValidateNested({ each: true })
  @Type(() => DidiUnbindShopDto)
  shops!: DidiUnbindShopDto[];

  @IsString()
  confirmation!: string;

  @IsOptional()
  @IsString()
  @Length(10, 500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  productionAcknowledged?: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  remotePageNo!: number;
}

export class ListDidiBoundStoresDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  pageNo = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 100;
}

export class ListDidiLocalStoresDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  pageNo = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 100;
}
