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
  Min,
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
  @IsIn(['setStock', 'setstockSync'])
  stockEndpoint?: 'setStock' | 'setstockSync';

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
