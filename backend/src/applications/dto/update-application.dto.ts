import { Country, DidiBindingEnvironment } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  appName?: string;

  @IsOptional()
  @IsString()
  appSecret?: string;

  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @IsOptional()
  @IsEnum(DidiBindingEnvironment)
  didiBindingEnvironment?: DidiBindingEnvironment | null;
}
