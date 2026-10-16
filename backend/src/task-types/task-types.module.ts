import { Module } from '@nestjs/common';
import { TaskTypesController } from './task-types.controller';
import { TaskTypesService } from './task-types.service';
import { SectionsModule } from '../sections/sections.module';
import { TaskTypeReleaseActivationService } from './task-type-release-activation.service';

@Module({
  imports: [SectionsModule],
  controllers: [TaskTypesController],
  providers: [TaskTypesService, TaskTypeReleaseActivationService],
})
export class TaskTypesModule {}
