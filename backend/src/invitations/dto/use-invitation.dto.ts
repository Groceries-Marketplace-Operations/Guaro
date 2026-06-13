import { IsString, MinLength } from 'class-validator';

export class UseInvitationDto {
  @IsString()
  @MinLength(2)
  nombre: string;
}
