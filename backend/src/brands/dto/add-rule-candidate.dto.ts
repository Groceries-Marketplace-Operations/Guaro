import { IsUUID } from 'class-validator';

export class AddRuleCandidateDto {
  @IsUUID()
  accountId: string;
}
