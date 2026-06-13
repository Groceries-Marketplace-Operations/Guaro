import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BlockStepDto } from './dto/block-step.dto';
import { CompleteStepDto } from './dto/complete-step.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { FailStepDto } from './dto/fail-step.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TasksController {
  constructor(private tasksService: TasksService) {}

  @Get()
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findAll(@CurrentUser() u: any) {
    return this.tasksService.findAll(u.roles, u.id, u.sectionId);
  }

  @Get(':id')
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin, AccountRol.director)
  findOne(@Param('id') id: string) {
    return this.tasksService.findOne(id);
  }

  @Post()
  @Roles(AccountRol.user, AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  create(@CurrentUser() u: any, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(dto, u.id);
  }

  @Patch(':id/steps/:stepId/complete')
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  completeStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: CompleteStepDto,
  ) {
    return this.tasksService.completeStep(id, stepId, dto.resultado, dto.nota);
  }

  @Patch(':id/steps/:stepId/fail')
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  failStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: FailStepDto,
  ) {
    return this.tasksService.failStep(id, stepId, dto.motivoFallo, dto.nota);
  }

  @Patch(':id/steps/:stepId/block')
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  blockStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: BlockStepDto,
  ) {
    return this.tasksService.blockStep(id, stepId, dto.nota);
  }

  @Patch(':id/steps/:stepId/retry')
  @Roles(AccountRol.bpo, AccountRol.admin, AccountRol.super_admin)
  retryStep(@Param('id') id: string, @Param('stepId') stepId: string) {
    return this.tasksService.retryStep(id, stepId);
  }
}
