import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

export class BrandMenuCategoryInput {
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'categoryId only accepts letters, numbers, underscores and hyphens' })
  categoryId: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ReplaceBrandMenuCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BrandMenuCategoryInput)
  categories: BrandMenuCategoryInput[];
}
