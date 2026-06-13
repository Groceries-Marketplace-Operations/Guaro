import { IsEnum, IsOptional, IsString } from 'class-validator';
import { StepMotivoFallo } from '@prisma/client';

export class FailStepDto {
  @IsEnum(StepMotivoFallo)
  motivoFallo: StepMotivoFallo;

  @IsOptional()
  @IsString()
  nota?: string;
}
