import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateTaskTypeDto {
  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsOptional()
  @IsBoolean()
  programable?: boolean;
}
