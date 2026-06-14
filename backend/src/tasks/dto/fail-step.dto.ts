import { IsEnum, IsOptional, IsString } from 'class-validator';
import { StepFailureReason } from '@prisma/client';

export class FailStepDto {
  @IsEnum(StepFailureReason)
  failureReason: StepFailureReason;

  @IsOptional()
  @IsString()
  note?: string;
}
