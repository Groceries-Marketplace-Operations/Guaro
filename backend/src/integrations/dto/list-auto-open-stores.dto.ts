import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum AutoOpenStoreInclusionFilter {
  all = 'all',
  included = 'included',
  emergency = 'emergency',
  configuration = 'configuration',
}

function trimmedOptionalString(value: unknown) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export class ListAutoOpenStoresDto {
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
  limit = 50;

  @IsOptional()
  @Transform(({ value }) => trimmedOptionalString(value))
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @IsOptional()
  @IsEnum(AutoOpenStoreInclusionFilter)
  inclusion: AutoOpenStoreInclusionFilter = AutoOpenStoreInclusionFilter.all;
}
