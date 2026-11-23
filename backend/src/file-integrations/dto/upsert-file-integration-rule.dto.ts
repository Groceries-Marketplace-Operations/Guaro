import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Country, FileIntegrationKind } from '@prisma/client';
import { SFTP_FILTER_MAX_CODES, SFTP_FILTER_MODES, SftpFilterMode } from '../file-integration.util';

export class UpsertFileIntegrationRuleDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsEnum(FileIntegrationKind)
  kind: FileIntegrationKind;

  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @IsUUID()
  sftpApplicationId: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(10080)
  intervalMinutes?: number;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  dailyTime?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  parallelism?: number;

  @IsOptional()
  @IsString()
  filePattern?: string;

  @IsOptional()
  @IsString()
  sourceScope?: string;

  @IsOptional()
  @IsIn(SFTP_FILTER_MODES)
  filterMode?: SftpFilterMode;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  thresholdAmount?: number;

  @IsOptional()
  @IsString()
  delimiter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  priceColumn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  upcColumn?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SFTP_FILTER_MAX_CODES)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  excludedUpcs?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxFilesPerRun?: number;
}
