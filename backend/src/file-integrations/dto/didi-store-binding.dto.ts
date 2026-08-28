import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
import { DidiStoreBindingAction, DidiStoreBindingItemStatus } from '@prisma/client';
import {
  DIDI_BIND_MAX_SHOPS,
  DIDI_MASS_MAX_SHOPS,
  DIDI_UNBIND_MAX_SHOPS,
} from '../didi-store-bindings.util';

export class DidiBindShopDto {
  @IsString({ message: 'shopId must be a string so its int64 value remains exact' })
  @Matches(/^57\d{17}$/, { message: 'shopId must be a 19-digit DiDi shop_id beginning with 57' })
  shopId!: string;

  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001F\u007F-\u009F]+$/u, { message: 'appShopId cannot contain control characters' })
  appShopId!: string;
}

export class DidiUnbindShopDto extends DidiBindShopDto {}

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
  @Length(1, 500)
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
  @Length(1, 500)
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

export class DidiMassBindingShopDto extends DidiBindShopDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  remotePageNo?: number;
}

export class CreateDidiStoreBindingExecutionDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsUUID()
  applicationId!: string;

  @IsEnum(DidiStoreBindingAction)
  action!: DidiStoreBindingAction;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DIDI_MASS_MAX_SHOPS)
  @ValidateNested({ each: true })
  @Type(() => DidiMassBindingShopDto)
  shops!: DidiMassBindingShopDto[];

  @IsString()
  @Length(1, 500)
  confirmation!: string;

  @IsOptional()
  @IsString()
  @Length(10, 500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  productionAcknowledged?: boolean;
}

export class ListDidiStoreBindingExecutionsDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take = 20;
}

export class GetDidiStoreBindingExecutionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  itemPageNo = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DIDI_MASS_MAX_SHOPS)
  itemPageSize = 100;

  @IsOptional()
  @IsEnum(DidiStoreBindingItemStatus)
  itemStatus?: DidiStoreBindingItemStatus;
}

export class SelectDidiLocalStoresDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  q?: string;
}
