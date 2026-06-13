import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { EstrategiaAsignacion, TipoEjecucion } from '@prisma/client';

export class UpdateStepDto {
  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  orden?: number;

  @IsOptional()
  @IsEnum(TipoEjecucion)
  tipoEjecucion?: TipoEjecucion;

  @IsOptional()
  @IsString()
  accion?: string;

  @IsOptional()
  @IsEnum(EstrategiaAsignacion)
  estrategiaAsignacion?: EstrategiaAsignacion;

  @IsOptional()
  @IsInt()
  @Min(1)
  peso?: number;

  @IsOptional()
  @IsUUID()
  handlerId?: string;
}
