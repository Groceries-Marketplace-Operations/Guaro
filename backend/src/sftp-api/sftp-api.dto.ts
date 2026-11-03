import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { IsInt, Max, Min } from 'class-validator';

export class SftpScheduleDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) time!: string;
  @IsIn(['full', 'delta']) mode!: 'full' | 'delta';
}

export class SftpApiDto {
  @IsUUID() brandId!: string;
  @IsUUID() applicationId!: string;
  @IsUUID() sftpApplicationId!: string;
  @IsString() @IsNotEmpty() @MaxLength(500) fileRegex!: string;
  @IsInt() @Min(1) @Max(525600) maxFileAgeMinutes!: number;
  @IsString() @IsNotEmpty() @MaxLength(1) delimiter!: string;
  @IsBoolean() hasHeader!: boolean;
  @IsOptional() @IsBoolean() renameFile?: boolean;
  @IsOptional() @IsString() @MaxLength(500) renameRegex?: string;
  @IsOptional() @IsString() @MaxLength(255) renameReplacement?: string;
  @IsOptional() @IsBoolean() convertEncoding?: boolean;
  @IsOptional() @IsIn(['windows-1252', 'utf-16le', 'utf-16be']) sourceEncoding?: string;
  @IsIn(['filename', 'column']) shopSource!: 'filename' | 'column';
  @IsString() @MaxLength(500) shopRegex!: string;
  @IsObject() mapping!: Record<string, string>;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(48) @ValidateNested({ each: true }) @Type(() => SftpScheduleDto) schedules!: SftpScheduleDto[];
  @IsBoolean() active!: boolean;
}

export class SftpApiRunDto {
  @IsIn(['full', 'delta']) mode!: 'full' | 'delta';
}
