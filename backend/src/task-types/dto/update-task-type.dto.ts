import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateTaskTypeDto {
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  schedulable?: boolean;
}
