import { IsBoolean, IsInt, IsNumber, ValidateIf, Max, Min } from 'class-validator';

export class UpdateCompletionRateDto {
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() crAutoClosureEnabled?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) crAutoClosureThreshold?: number;
  @ValidateIf((_object, value) => value !== undefined) @IsInt() @Min(1) @Max(1000000) crAutoClosureMinOrders?: number;
  @IsBoolean() crAlertsEnabled: boolean;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) crBaselineCancelRate: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.01) @Max(100) crDeviationPoints: number;
  @IsInt() @Min(4) @Max(1000000) crMinOrders: number;
}
