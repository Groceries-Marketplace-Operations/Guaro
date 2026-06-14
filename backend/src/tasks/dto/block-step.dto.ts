import { IsOptional, IsString } from 'class-validator';

export class BlockStepDto {
  @IsOptional()
  @IsString()
  note?: string;
}
