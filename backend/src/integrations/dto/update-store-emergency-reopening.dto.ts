import { Type } from 'class-transformer';
import { IsDate, MinDate } from 'class-validator';

export class UpdateStoreEmergencyReopeningDto {
  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date())
  endsAt: Date;
}
