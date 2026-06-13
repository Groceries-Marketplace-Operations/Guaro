import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { FormFieldTipo } from '@prisma/client';

export class UpdateFormFieldDto {
  @IsOptional()
  @IsString()
  etiqueta?: string;

  @IsOptional()
  @IsEnum(FormFieldTipo)
  tipo?: FormFieldTipo;

  @IsOptional()
  @IsBoolean()
  requerido?: boolean;

  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @IsOptional()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opciones?: any;

  @IsOptional()
  @IsInt()
  @Min(1)
  orden?: number;

  @IsOptional()
  @IsUUID()
  filtraPorId?: string;
}
