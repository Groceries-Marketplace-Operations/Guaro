import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TaskPriority } from '@prisma/client';

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

  @IsOptional()
  @IsEnum(TaskPriority)
  defaultPriority?: TaskPriority;

  @IsOptional() @IsInt() @Min(15) @Max(43200)
  deliveryMinutes?: number | null;

  @IsOptional() @IsArray() @ArrayNotEmpty() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  workDays?: number[];

  @IsOptional() @IsInt() @Min(0) @Max(1439)
  workStartMinute?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1439)
  workEndMinute?: number;

  @IsOptional() @IsString()
  workTimeZone?: string;
}
