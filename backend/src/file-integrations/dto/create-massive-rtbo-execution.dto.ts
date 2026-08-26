import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

const normalizeShopIds = ({ value }: { value: unknown }) => {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(values.map(entry => String(entry ?? '').trim()).filter(Boolean))];
};

export class CreateMassiveRtboExecutionDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @Transform(normalizeShopIds)
  @IsArray()
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  @Matches(/^57\d{17}$/, { each: true, message: 'Each shopIds value must be a 19-digit DiDi shop_id beginning with 57' })
  shopIds?: string[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86400)
  promiseProduceTime!: number;
}
