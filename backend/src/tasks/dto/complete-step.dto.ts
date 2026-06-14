import { IsOptional, IsString } from 'class-validator';

export class CompleteStepDto {
  @IsOptional()
  result?: unknown;

  @IsOptional()
  @IsString()
  note?: string;
}
