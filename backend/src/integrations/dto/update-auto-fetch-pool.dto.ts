import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

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

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { each: true })
  executionTimes?: string[];
}
