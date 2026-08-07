import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength, ArrayMaxSize, ArrayMinSize } from 'class-validator';

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
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  upcs!: string[];

  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  runNow?: boolean;
}
