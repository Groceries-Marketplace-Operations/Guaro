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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AutoTurnOffUpcGroupDto } from './auto-turn-off-upc-group.dto';

export class CreateAutoTurnOffRuleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsUUID()
  brandId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9000)
  @IsString({ each: true })
  shopIds: string[];

  @ValidateIf(dto => !dto.upcGroups)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  upcs?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AutoTurnOffUpcGroupDto)
  upcGroups?: AutoTurnOffUpcGroupDto[];

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

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  stockValue?: number;

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
