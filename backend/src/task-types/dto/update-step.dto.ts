import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,

  Min,
} from 'class-validator';
import { AssignmentStrategy, ExecutionType } from '@prisma/client';

export class UpdateStepDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  order?: number;

  @IsOptional()
  @IsEnum(ExecutionType)
  executionType?: ExecutionType;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsEnum(AssignmentStrategy)
  assignmentStrategy?: AssignmentStrategy;

  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  @IsOptional()
  @IsString()
  handlerId?: string;
}
