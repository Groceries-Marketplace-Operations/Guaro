import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,

  Min,
  ValidateIf,
} from 'class-validator';
import { AssignmentStrategy, ExecutionType } from '@prisma/client';

export class CreateStepDto {
  @IsString()
  name: string;

  @IsInt()
  @Min(1)
  order: number;

  @IsEnum(ExecutionType)
  executionType: ExecutionType;

  @IsOptional()
  @IsString()
  action?: string;

  @IsEnum(AssignmentStrategy)
  assignmentStrategy: AssignmentStrategy;

  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  // Only if executionType === automatic
  @ValidateIf((o) => o.executionType === ExecutionType.automatic)
  @IsString()
  handlerId?: string;
}
