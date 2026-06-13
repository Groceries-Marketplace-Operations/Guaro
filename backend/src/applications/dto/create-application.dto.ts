import { IsEnum, IsString } from 'class-validator';
import { Country } from '@prisma/client';

export class CreateApplicationDto {
  @IsString()
  appId: string;

  @IsString()
  appName: string;

  @IsEnum(Country)
  country: Country;

  @IsString()
  appSecret: string;
}
