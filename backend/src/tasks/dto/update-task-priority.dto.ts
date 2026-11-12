import { TaskPriority } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateTaskPriorityDto {
  @IsEnum(TaskPriority)
  priority: TaskPriority;
}
