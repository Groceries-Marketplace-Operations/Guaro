import { IsEnum, IsString, Matches } from 'class-validator';
import { DayOfWeek } from '@prisma/client';

export class CreateScheduleDto {
  @IsEnum(DayOfWeek)
  day: DayOfWeek;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'openTime must be HH:MM' })
  openTime: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'closeTime must be HH:MM' })
  closeTime: string;
}
