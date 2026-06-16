import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class UpsertOptionDto {
  @IsString()
  category: string;

  @IsString()
  value: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}
