import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, ArrayMaxSize, ArrayMinSize } from 'class-validator';

function normalizeList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(source.map(item => String(item).trim()).filter(Boolean))];
}

export class UpsertTargetedMenuRuleDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsUUID()
  brandId!: string;

  @Transform(({ value }) => normalizeList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  shopIds!: string[];

  @Transform(({ value }) => normalizeList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  upcs!: string[];

  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @Transform(({ value }) => value === undefined || value === null || value === '' ? undefined : Number(value))
  @IsOptional()
  @IsIn([0, 1])
  mergePolicy?: number;

  @IsOptional()
  @IsIn(['uploadGrocery', 'updateItemsync'])
  uploadEndpoint?: string;

  @IsOptional()
  @IsBoolean()
  runNow?: boolean;
}
