import { IsOptional, IsString } from 'class-validator';

export class BlockStepDto {
  @IsOptional()
  @IsString()
  nota?: string;
}
