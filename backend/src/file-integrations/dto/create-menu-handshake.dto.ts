import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

const normalizeShopIds = ({ value }: { value: unknown }) => {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(values.map(entry => String(entry ?? '').trim()).filter(Boolean))];
};

export class CreateMenuHandshakeDto {
  @IsUUID()
  brandId!: string;

  @IsIn(['all_brand', 'shop_list'])
  mode!: 'all_brand' | 'shop_list';

  @IsOptional()
  @Transform(normalizeShopIds)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @Matches(/^57\d{17}$/, { each: true, message: 'Each shopIds value must be a 19-digit DiDi shop_id beginning with 57' })
  shopIds?: string[];
}
