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
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class UpsertUpcActivityPriceRuleDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsUUID()
  applicationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  shopIds: string[];

  @IsString()
  @Matches(/^\d{6,20}$/)
  targetUpc: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(23, { each: true })
  scheduleHours: number[];

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1)
  storeConcurrency?: number;

  @IsOptional()
  @IsBoolean()
  runNow?: boolean;
}
