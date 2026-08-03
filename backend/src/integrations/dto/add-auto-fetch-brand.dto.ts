import { IsUUID } from 'class-validator';

export class AddAutoFetchBrandDto {
  @IsUUID()
  brandId: string;
}
