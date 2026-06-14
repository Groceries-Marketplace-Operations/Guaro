import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,

  Min,
} from 'class-validator';
import { FormFieldTipo } from '@prisma/client';

export class UpdateFormFieldDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsEnum(FormFieldTipo)
  type?: FormFieldTipo;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @IsOptional()
  options?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  order?: number;

  @IsOptional()
  @IsString()
  filteredById?: string;
}
