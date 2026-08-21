import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  Country,
  KaType,
  StoreOnboardingNotificationFrequency,
  StoreOnboardingSource,
} from '@prisma/client';

export class UpdateStoreOnboardingControlDto {
  @IsBoolean()
  globalEnabled!: boolean;

  @IsBoolean()
  notificationsEnabled!: boolean;

  @IsOptional()
  @IsBoolean()
  activationConfirmed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  reason?: string;
}

export class StoreOnboardingRolloutSourceDto {
  @IsEnum(StoreOnboardingSource)
  source!: StoreOnboardingSource;

  @IsUUID()
  taskTypeId!: string;
}

export class PutStoreOnboardingRolloutDto {
  @IsEnum(Country)
  country!: Country;

  @IsEnum(KaType)
  kaType!: KaType;

  @ValidateIf(object => !object.sources)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => StoreOnboardingRolloutSourceDto)
  sourceTaskTypes?: StoreOnboardingRolloutSourceDto[];

  // Backward-compatible editor shape. The service normalizes it to immutable
  // rollout_source rows and still requires an explicit TaskType ID per source.
  @ValidateIf(object => !object.sourceTaskTypes)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsEnum(StoreOnboardingSource, { each: true })
  sources?: StoreOnboardingSource[];

  @IsOptional()
  @IsObject()
  taskTypeIds?: Partial<Record<StoreOnboardingSource, string>>;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsBoolean()
  activationConfirmed?: boolean;

  @IsDateString()
  effectiveAt!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/i)
  workflowVersion!: string;

  @IsBoolean()
  newRequestsOnly!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  notificationProfileId?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  brandTaskTypeId?: string | null;
}

export class PutStoreOnboardingNotificationProfileDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/i)
  logicalKey?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsEnum(Country)
  country?: Country | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsEnum(KaType)
  kaType?: KaType | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsEnum(StoreOnboardingSource, { each: true })
  sources!: StoreOnboardingSource[];

  @IsUUID()
  webhookId!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsBoolean()
  activationConfirmed?: boolean;

  @IsEnum(StoreOnboardingNotificationFrequency)
  frequency!: StoreOnboardingNotificationFrequency;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_080)
  intervalMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
  scheduledTime?: string | null;

  @IsString()
  @MaxLength(100)
  timezone!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  criticalEvents!: string[];

  @IsString()
  @MaxLength(10_000)
  template!: string;
}
