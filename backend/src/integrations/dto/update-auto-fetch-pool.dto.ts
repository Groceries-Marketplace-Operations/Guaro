import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateAutoFetchPoolDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  executionHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(59)
  executionMinute?: number;
}
