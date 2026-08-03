import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateAutoTurnOffRuleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsUUID()
  brandId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  shopIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  upcs: string[];

  @IsOptional()
  @IsString()
  @IsIn(['interval', 'daily_times'])
  scheduleMode?: 'interval' | 'daily_times';

  @ValidateIf(dto => !dto.scheduleMode || dto.scheduleMode === 'interval')
  @IsInt()
  @Min(1)
  @Max(525600)
  intervalMinutes?: number;

  @ValidateIf(dto => dto.scheduleMode === 'daily_times')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(48)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { each: true })
  executionTimes?: string[];

  @IsString()
  @IsIn(['setStock', 'setstockSync'])
  stockEndpoint: 'setStock' | 'setstockSync';

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
