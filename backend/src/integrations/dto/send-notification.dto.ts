import { IsArray, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class SendNotificationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  @MinLength(1)
  message: string;

  @IsArray()
  @IsUUID('all', { each: true })
  webhookIds: string[];

  @IsOptional()
  @IsIn(['#2D9CDB', '#27AE60', '#E2B93B', '#EB5757'])
  color?: string;
}
