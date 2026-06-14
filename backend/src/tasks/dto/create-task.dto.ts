import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,

  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class FormValueInput {
  @IsString()
  formFieldId: string;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  shopId?: string;
}

export class CreateTaskDto {
  @IsString()
  taskTypeId: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  shopIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormValueInput)
  formValues?: FormValueInput[];

  @IsOptional()
  @IsDateString()
  scheduledStart?: string;

  @ValidateIf((o) => !!o.scheduledStart)
  @IsDateString()
  scheduledEnd?: string;
}
