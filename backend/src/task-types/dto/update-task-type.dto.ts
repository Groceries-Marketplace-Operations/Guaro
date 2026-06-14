import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateTaskTypeDto {
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
