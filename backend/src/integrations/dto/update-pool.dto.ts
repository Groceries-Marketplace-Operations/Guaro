import { Country } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class UpdatePoolDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsEnum(Country)
  country?: Country;

  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(23, { each: true })
  executionHours?: number[];

  @IsOptional() @IsUUID()
  webhookId?: string | null;

  @IsOptional() @IsArray() @IsUUID('4', { each: true })
  brandIds?: string[];

  @IsOptional() @IsBoolean()
  active?: boolean;
}
