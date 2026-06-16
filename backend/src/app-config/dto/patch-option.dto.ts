import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class PatchOptionDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}
