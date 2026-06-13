import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateTaskTypeDto {
  @IsUUID()
  sectionId: string;

  @IsString()
  nombre: string;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsOptional()
  @IsBoolean()
  programable?: boolean;
}
