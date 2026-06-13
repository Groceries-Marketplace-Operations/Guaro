import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AddStepWebhookDto } from './dto/add-step-webhook.dto';
import { CreateFormFieldDto } from './dto/create-form-field.dto';
import { CreateStepDto } from './dto/create-step.dto';
import { CreateTaskTypeDto } from './dto/create-task-type.dto';
import { UpdateFormFieldDto } from './dto/update-form-field.dto';
import { UpdateStepDto } from './dto/update-step.dto';
import { UpdateTaskTypeDto } from './dto/update-task-type.dto';
import { TaskTypesService } from './task-types.service';

@Controller('task-types')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TaskTypesController {
  constructor(private taskTypesService: TaskTypesService) {}

  // ── TaskType ──────────────────────────────────────────────────────────────

  @Get()
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.user, AccountRol.bpo, AccountRol.director)
  findAll(@CurrentUser() u: any) {
    return this.taskTypesService.findAll(u.roles, u.sectionId);
  }

  @Get(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin, AccountRol.user, AccountRol.bpo, AccountRol.director)
  findOne(@Param('id') id: string) {
    return this.taskTypesService.findOne(id);
  }

  @Post()
  @Roles(AccountRol.admin, AccountRol.super_admin)
  create(@CurrentUser() u: any, @Body() dto: CreateTaskTypeDto) {
    return this.taskTypesService.create(dto, u.roles, u.sectionId);
  }

  @Patch(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  update(@Param('id') id: string, @CurrentUser() u: any, @Body() dto: UpdateTaskTypeDto) {
    return this.taskTypesService.update(id, dto, u.roles, u.sectionId);
  }

  @Delete(':id')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  remove(@Param('id') id: string, @CurrentUser() u: any) {
    return this.taskTypesService.remove(id, u.roles, u.sectionId);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  @Post(':id/steps')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  createStep(@Param('id') id: string, @CurrentUser() u: any, @Body() dto: CreateStepDto) {
    return this.taskTypesService.createStep(id, dto, u.roles, u.sectionId);
  }

  @Patch(':id/steps/:stepId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  updateStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: any, @Body() dto: UpdateStepDto) {
    return this.taskTypesService.updateStep(id, stepId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: any) {
    return this.taskTypesService.removeStep(id, stepId, u.roles, u.sectionId);
  }

  // ── Candidatos ────────────────────────────────────────────────────────────

  @Post(':id/steps/:stepId/candidates')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  addCandidate(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @CurrentUser() u: any,
    @Body('accountId') accountId: string,
  ) {
    return this.taskTypesService.addCandidate(id, stepId, accountId, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId/candidates/:accountId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeCandidate(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Param('accountId') accountId: string,
    @CurrentUser() u: any,
  ) {
    return this.taskTypesService.removeCandidate(id, stepId, accountId, u.roles, u.sectionId);
  }

  // ── Step Webhooks ─────────────────────────────────────────────────────────

  @Post(':id/steps/:stepId/webhooks')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  addStepWebhook(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @CurrentUser() u: any,
    @Body() dto: AddStepWebhookDto,
  ) {
    return this.taskTypesService.addStepWebhook(id, stepId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId/webhooks/:swId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeStepWebhook(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Param('swId') swId: string,
    @CurrentUser() u: any,
  ) {
    return this.taskTypesService.removeStepWebhook(id, stepId, swId, u.roles, u.sectionId);
  }

  // ── Form Fields ───────────────────────────────────────────────────────────

  @Post(':id/fields')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  createField(@Param('id') id: string, @CurrentUser() u: any, @Body() dto: CreateFormFieldDto) {
    return this.taskTypesService.createField(id, dto, u.roles, u.sectionId);
  }

  @Patch(':id/fields/:fieldId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  updateField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
    @CurrentUser() u: any,
    @Body() dto: UpdateFormFieldDto,
  ) {
    return this.taskTypesService.updateField(id, fieldId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/fields/:fieldId')
  @Roles(AccountRol.admin, AccountRol.super_admin)
  removeField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
    @CurrentUser() u: any,
  ) {
    return this.taskTypesService.removeField(id, fieldId, u.roles, u.sectionId);
  }
}
