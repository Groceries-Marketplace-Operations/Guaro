import { IsOptional, IsString } from 'class-validator';

export class CompleteStepDto {
  @IsOptional()
  resultado?: unknown;

  @IsOptional()
  @IsString()
  nota?: string;
}
