import { IsString } from 'class-validator';

export class AddRuleCandidateDto {
  @IsString()
  accountId: string;
}
