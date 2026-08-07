import { Module } from '@nestjs/common';
import { TaskTypesController } from './task-types.controller';
import { TaskTypesService } from './task-types.service';
import { SectionsModule } from '../sections/sections.module';

@Module({
  imports: [SectionsModule],
  controllers: [TaskTypesController],
  providers: [TaskTypesService],
})
export class TaskTypesModule {}
