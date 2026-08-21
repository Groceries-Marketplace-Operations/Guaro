import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Allow,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  Country,
  KaType,
  StoreOnboardingSource,
  StoreOnboardingStage,
  StoreOnboardingStatus,
} from '@prisma/client';

export class StoreOnboardingListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsEnum(StoreOnboardingStatus) status?: StoreOnboardingStatus;
  @IsOptional() @IsEnum(StoreOnboardingSource) source?: StoreOnboardingSource;
  @IsOptional() @IsEnum(StoreOnboardingStage) stage?: StoreOnboardingStage;
  @IsOptional() @IsEnum(KaType) kaType?: KaType;
  @IsOptional() @IsEnum(Country) country?: Country;
}

export class StoreOnboardingUnitIdentityDto {
  @IsOptional() @IsUUID() shopId?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) externalShopId!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) appShopId!: string;
}

export class SubmitStoreOnboardingShopIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => StoreOnboardingUnitIdentityDto)
  units!: StoreOnboardingUnitIdentityDto[];
}

export class StoreOnboardingBriefFieldDto {
  @IsString() @MaxLength(100) id!: string;
  @IsString() @MaxLength(200) label!: string;
  @IsString() @MaxLength(40) type!: string;
  @Allow() value!: string | number;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) options?: string[];
}

export class StoreOnboardingUnitConfigurationDto {
  @IsUUID() unitId!: string;
  @IsObject() input!: Record<string, boolean | string | number | null>;
}

export class UpdateStoreOnboardingBriefDto {
  @IsString() @MaxLength(20_000) instructions!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => StoreOnboardingBriefFieldDto)
  fields?: StoreOnboardingBriefFieldDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => StoreOnboardingUnitConfigurationDto)
  units?: StoreOnboardingUnitConfigurationDto[];
}

export class UpdateStoreOnboardingChecklistDto {
  @IsObject() checklist!: Record<string, boolean | string | number | null>;
  @IsOptional() @IsString() @MaxLength(4_000) note?: string;
}

export class TransitionStoreOnboardingUnitDto {
  @IsEnum(StoreOnboardingStage) stage!: StoreOnboardingStage;
  @IsOptional() @IsString() @MaxLength(4_000) note?: string;
}

export class AuditStoreOnboardingUnitDto {
  @IsIn(['approved', 'rejected', 'needs_information'])
  decision!: 'approved' | 'rejected' | 'needs_information';
  @IsOptional() @IsString() @MaxLength(4_000) note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(1_000, { each: true })
  evidence?: string[];
}

export class AssignStoreOnboardingUnitDto {
  @IsOptional() @IsUUID() configurationAssigneeId?: string | null;
  @IsOptional() @IsUUID() commercialAssigneeId?: string | null;
  @IsOptional() @IsUUID() goLiveAssigneeId?: string | null;
}

export class AssignStoreOnboardingConfigurationBriefDto {
  @IsOptional() @IsUUID() accountId?: string | null;
}

export class GoLiveStoreOnboardingDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true })
  unitIds!: string[];
}

export class StoreOnboardingTimelineQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() unitId?: string;
}
