import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,

  IsString,
  Min,
} from 'class-validator';
import { FormFieldTipo } from '@prisma/client';

export class CreateFormFieldDto {
  @IsString()
  label: string;

  @IsEnum(FormFieldTipo)
  type: FormFieldTipo;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @IsOptional()
  options?: string[];

  @IsInt()
  @Min(1)
  order: number;

  @IsOptional()
  @IsString()
  filteredById?: string;
}
