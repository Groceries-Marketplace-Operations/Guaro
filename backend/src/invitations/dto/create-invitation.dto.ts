import { IsEnum, IsOptional, IsString } from 'class-validator';
import { AccountRole } from '@prisma/client';

export class CreateInvitationDto {
  @IsEnum(AccountRole)
  role: AccountRole;

  @IsOptional()
  @IsString()
  sectionId?: string;
}
