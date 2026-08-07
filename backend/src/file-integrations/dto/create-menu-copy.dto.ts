import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

const normalize = ({ value }: { value: unknown }) => String(value ?? '').trim();

export class CreateMenuCopyDto {
  @IsUUID()
  sourceApplicationId!: string;

  @Transform(normalize)
  @IsString()
  @Matches(/^57\d{17}$/, { message: 'sourceShopId must be a 19-digit DiDi shop_id beginning with 57' })
  sourceShopId!: string;

  @IsUUID()
  targetApplicationId!: string;

  @Transform(normalize)
  @IsString()
  @Matches(/^57\d{17}$/, { message: 'targetShopId must be a 19-digit DiDi shop_id beginning with 57' })
  targetShopId!: string;

  @IsIn([0, 1])
  mergePolicy!: number;

  @IsOptional()
  @IsIn(['uploadGrocery', 'updateItemsync'])
  uploadEndpoint?: string;
}
