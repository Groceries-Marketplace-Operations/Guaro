import { IsBoolean } from 'class-validator';

export class UpdateAutoFetchBrandDto {
  @IsBoolean()
  active: boolean;
}
