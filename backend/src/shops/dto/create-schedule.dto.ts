import { IsEnum, IsString, Matches } from 'class-validator';
import { DiaSemana } from '@prisma/client';

export class CreateScheduleDto {
  @IsEnum(DiaSemana)
  dia: DiaSemana;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'apertura debe ser HH:MM' })
  apertura: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'cierre debe ser HH:MM' })
  cierre: string;
}
