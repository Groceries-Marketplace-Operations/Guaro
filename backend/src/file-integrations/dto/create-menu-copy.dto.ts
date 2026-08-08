import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

const normalize = ({ value }: { value: unknown }) => String(value ?? '').trim();
const normalizeShopIds = ({ value }: { value: unknown }) => {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(values.map(entry => String(entry ?? '').trim()).filter(Boolean))];
};

export class CreateMenuCopyDto {
  @IsUUID()
  sourceApplicationId!: string;

  @Transform(normalize)
  @IsString()
  @Matches(/^57\d{17}$/, { message: 'sourceShopId must be a 19-digit DiDi shop_id beginning with 57' })
  sourceShopId!: string;

  @IsUUID()
  targetApplicationId!: string;

  /** Legacy single-target field kept for API compatibility. */
  @IsOptional()
  @Transform(normalize)
  @IsString()
  @Matches(/^57\d{17}$/, { message: 'targetShopId must be a 19-digit DiDi shop_id beginning with 57' })
  targetShopId?: string;

  @IsOptional()
  @Transform(normalizeShopIds)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(/^57\d{17}$/, { each: true, message: 'Each targetShopIds value must be a 19-digit DiDi shop_id beginning with 57' })
  targetShopIds?: string[];

  @IsIn([0, 1])
  mergePolicy!: number;

  @IsOptional()
  @IsIn(['uploadGrocery', 'updateItemsync'])
  uploadEndpoint?: string;
}
