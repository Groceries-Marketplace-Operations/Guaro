import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AccountRole } from '@prisma/client';

export class CreateInvitationDto {
  @IsEnum(AccountRole)
  role: AccountRole;

  @IsOptional()
  @IsString()
  sectionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  maxUses?: number;
}
