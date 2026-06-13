import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import { EstrategiaAsignacion, TipoEjecucion } from '@prisma/client';

export class CreateStepDto {
  @IsString()
  nombre: string;

  @IsInt()
  @Min(1)
  orden: number;

  @IsEnum(TipoEjecucion)
  tipoEjecucion: TipoEjecucion;

  @IsOptional()
  @IsString()
  accion?: string;

  @IsEnum(EstrategiaAsignacion)
  estrategiaAsignacion: EstrategiaAsignacion;

  @IsOptional()
  @IsInt()
  @Min(1)
  peso?: number;

  // Solo si tipoEjecucion === automatico
  @ValidateIf((o) => o.tipoEjecucion === TipoEjecucion.automatico)
  @IsUUID()
  handlerId?: string;
}
