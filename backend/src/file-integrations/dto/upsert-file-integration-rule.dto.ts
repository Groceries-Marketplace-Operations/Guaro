import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
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
  @Max(1000)
  maxFilesPerRun?: number;
}
