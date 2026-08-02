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
  Min,
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

  @IsInt()
  @Min(1)
  @Max(525600)
  intervalMinutes: number;

  @IsString()
  @IsIn(['setStock', 'setstockSync'])
  stockEndpoint: 'setStock' | 'setstockSync';

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
