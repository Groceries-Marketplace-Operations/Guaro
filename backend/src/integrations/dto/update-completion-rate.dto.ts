import { IsBoolean, IsInt, IsNumber, Max, Min } from 'class-validator';

export class UpdateCompletionRateDto {
  @IsBoolean() crAlertsEnabled: boolean;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) crBaselineCancelRate: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.01) @Max(100) crDeviationPoints: number;
  @IsInt() @Min(4) @Max(1000000) crMinOrders: number;
}
