import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class UpsertOfferMenuUploadRuleDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsUUID()
  sftpApplicationId: string;

  @IsUUID()
  applicationId: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(23, { each: true })
  scheduleHours: number[];

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  filePattern?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  delimiter?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]+$/)
  categoryIdPrefix?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  categoryName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]+$/)
  menuIdPrefix?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  menuNamePrefix?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  mergePolicy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  storeConcurrency?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30000)
  maxItemsPerStore?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxItemsPerCategory?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  activeStatus?: number;

  @IsOptional()
  @IsBoolean()
  includeTaxInfo?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  taxType?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  taxRate?: number;

  @IsOptional()
  @IsBoolean()
  runNow?: boolean;
}
