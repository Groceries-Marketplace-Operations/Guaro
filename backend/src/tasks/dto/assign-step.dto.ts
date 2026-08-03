import { IsUUID } from 'class-validator';

export class AssignStepDto {
  @IsUUID()
  accountId: string;
}
