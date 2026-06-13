import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AccountRol } from '@prisma/client';

export class CreateInvitationDto {
  @IsEnum(AccountRol)
  rol: AccountRol;

  @IsOptional()
  @IsUUID()
  sectionId?: string;
}
