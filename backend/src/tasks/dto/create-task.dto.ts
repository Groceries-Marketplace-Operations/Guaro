import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class FormValueInput {
  @IsUUID()
  formFieldId: string;

  @IsOptional()
  @IsString()
  valor?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsUUID()
  shopId?: string;
}

export class CreateTaskDto {
  @IsUUID()
  taskTypeId: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  shopIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormValueInput)
  formValues?: FormValueInput[];

  @IsOptional()
  @IsDateString()
  programadoInicio?: string;

  @ValidateIf((o) => !!o.programadoInicio)
  @IsDateString()
  programadoFin?: string;
}
