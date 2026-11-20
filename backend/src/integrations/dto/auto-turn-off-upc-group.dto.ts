import 'reflect-metadata';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class AutoTurnOffUpcGroupDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsUUID()
  responsibleId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  upcs: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
