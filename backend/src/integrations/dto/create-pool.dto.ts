import { Country } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreatePoolDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsEnum(Country)
  country: Country;

  @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(23, { each: true })
  executionHours: number[];

  @IsOptional() @IsUUID()
  webhookId?: string;

  @IsArray() @IsUUID('4', { each: true })
  brandIds: string[];
}
