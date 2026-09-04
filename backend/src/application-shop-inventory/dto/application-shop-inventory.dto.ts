import { IsUUID } from 'class-validator';

export class AddApplicationShopInventoryDto {
  @IsUUID()
  applicationId!: string;
}
