import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Country, DidiBindingEnvironment } from '@prisma/client';

export class CreateApplicationDto {
  @IsString()
  appId: string;

  @IsString()
  appName: string;

  @IsEnum(Country)
  country: Country;

  @IsString()
  appSecret: string;

  @IsOptional()
  @IsEnum(DidiBindingEnvironment)
  didiBindingEnvironment?: DidiBindingEnvironment | null;
}
