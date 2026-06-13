import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  IsString,
  Min,
} from 'class-validator';
import { FormFieldTipo } from '@prisma/client';

export class CreateFormFieldDto {
  @IsString()
  etiqueta: string;

  @IsEnum(FormFieldTipo)
  tipo: FormFieldTipo;

  @IsOptional()
  @IsBoolean()
  requerido?: boolean;

  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @IsOptional()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opciones?: any;

  @IsInt()
  @Min(1)
  orden: number;

  @IsOptional()
  @IsUUID()
  filtraPorId?: string;
}
