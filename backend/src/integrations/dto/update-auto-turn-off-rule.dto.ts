import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateAutoTurnOffRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  shopIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  upcs?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(525600)
  intervalMinutes?: number;

  @IsOptional()
  @IsString()
  @IsIn(['interval', 'daily_times'])
  scheduleMode?: 'interval' | 'daily_times';

  @ValidateIf(dto => dto.scheduleMode === 'daily_times'
    || (dto.scheduleMode === undefined && dto.executionTimes !== undefined))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(48)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { each: true })
  executionTimes?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['setStock', 'setstockSync'])
  stockEndpoint?: 'setStock' | 'setstockSync';

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
