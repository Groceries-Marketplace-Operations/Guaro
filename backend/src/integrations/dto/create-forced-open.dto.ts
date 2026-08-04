import { ArrayMaxSize, IsArray, IsIn, IsString, IsUUID, ValidateIf } from 'class-validator';

export class CreateForcedOpenDto {
  @IsUUID()
  brandId: string;

  @IsIn(['all_brand', 'shop_list'])
  mode: 'all_brand' | 'shop_list';

  @ValidateIf(dto => dto.mode === 'shop_list')
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsString({ each: true })
  shopIds?: string[];
}
