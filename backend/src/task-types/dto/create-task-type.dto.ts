import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateTaskTypeDto {
  @IsString()
  sectionId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  schedulable?: boolean;
}
