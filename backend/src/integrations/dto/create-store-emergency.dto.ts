import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDate, IsIn, IsString, IsUUID, MinDate, ValidateIf } from 'class-validator';

export class CreateStoreEmergencyDto {
  @IsUUID()
  brandId: string;

  @IsIn(['all_brand', 'shop_list'])
  mode: 'all_brand' | 'shop_list';

  @ValidateIf(dto => dto.mode === 'shop_list')
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsString({ each: true })
  shopIds?: string[];

  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date())
  endsAt: Date;
}
