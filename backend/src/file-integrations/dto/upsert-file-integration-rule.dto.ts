import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';
import { Country, FileIntegrationKind } from '@prisma/client';

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
  @Min(1)
  @Max(5000)
  maxFilesPerRun?: number;
}
