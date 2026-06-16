import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
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
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.user, AccountRole.bpo, AccountRole.director)
  findAll(
    @CurrentUser() u: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('q') q?: string,
  ) {
    return this.taskTypesService.findAll(u.roles, u.sectionId, { page, limit, q });
  }

  @Get(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin, AccountRole.user, AccountRole.bpo, AccountRole.director)
  findOne(@Param('id') id: string) {
    return this.taskTypesService.findOne(id);
  }

  @Post()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateTaskTypeDto) {
    return this.taskTypesService.create(dto, u.roles, u.sectionId);
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  update(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body() dto: UpdateTaskTypeDto) {
    return this.taskTypesService.update(id, dto, u.roles, u.sectionId);
  }

  @Patch(':id/toggle-active')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  toggleActive(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.taskTypesService.toggleActive(id, u.roles, u.sectionId);
  }

  @Delete(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  remove(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.taskTypesService.remove(id, u.roles, u.sectionId);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  @Post(':id/steps')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  createStep(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body() dto: CreateStepDto) {
    return this.taskTypesService.createStep(id, dto, u.roles, u.sectionId);
  }

  @Patch(':id/steps/reorder')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  reorderSteps(
    @Param('id') id: string,
    @CurrentUser() u: JwtUser,
    @Body() body: { order: { id: string; order: number }[] },
  ) {
    return this.taskTypesService.reorderSteps(id, body.order, u.roles, u.sectionId);
  }

  @Patch(':id/steps/:stepId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  updateStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: JwtUser, @Body() dto: UpdateStepDto) {
    return this.taskTypesService.updateStep(id, stepId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: JwtUser) {
    return this.taskTypesService.removeStep(id, stepId, u.roles, u.sectionId);
  }

  // ── Candidatos ────────────────────────────────────────────────────────────

  @Post(':id/steps/:stepId/candidates')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  addCandidate(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @CurrentUser() u: JwtUser,
    @Body('accountId') accountId: string,
  ) {
    return this.taskTypesService.addCandidate(id, stepId, accountId, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId/candidates/:accountId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeCandidate(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Param('accountId') accountId: string,
    @CurrentUser() u: JwtUser,
  ) {
    return this.taskTypesService.removeCandidate(id, stepId, accountId, u.roles, u.sectionId);
  }

  // ── Step Webhooks ─────────────────────────────────────────────────────────

  @Post(':id/steps/:stepId/webhooks')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  addStepWebhook(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @CurrentUser() u: JwtUser,
    @Body() dto: AddStepWebhookDto,
  ) {
    return this.taskTypesService.addStepWebhook(id, stepId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/steps/:stepId/webhooks/:swId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeStepWebhook(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Param('swId') swId: string,
    @CurrentUser() u: JwtUser,
  ) {
    return this.taskTypesService.removeStepWebhook(id, stepId, swId, u.roles, u.sectionId);
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  @Post(':id/templates')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  addTemplate(
    @Param('id') id: string,
    @CurrentUser() u: JwtUser,
    @Body() dto: { name: string; url: string; tipo?: string },
  ) {
    return this.taskTypesService.addTemplate(id, dto, u.roles, u.sectionId);
  }

  @Post(':id/templates/upload')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: join(process.cwd(), 'uploads'),
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        cb(null, `${randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
      const allowed = ['.xlsx', '.csv', '.docx', '.pdf'];
      const ext = extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) {
        return cb(new BadRequestException(`File type not allowed. Allowed: ${allowed.join(', ')}`), false);
      }
      cb(null, true);
    },
  }))
  async uploadTemplate(
    @Param('id') id: string,
    @CurrentUser() u: JwtUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    if (!name?.trim()) throw new BadRequestException('Template name is required');

    const ext = extname(file.originalname).toLowerCase().replace('.', '');
    const url = `/uploads/${file.filename}`;
    return this.taskTypesService.addTemplate(id, { name, url, tipo: ext }, u.roles, u.sectionId);
  }

  @Delete(':id/templates/:templateId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeTemplate(
    @Param('id') id: string,
    @Param('templateId') templateId: string,
    @CurrentUser() u: JwtUser,
  ) {
    return this.taskTypesService.removeTemplate(id, templateId, u.roles, u.sectionId);
  }

  // ── Form Fields ───────────────────────────────────────────────────────────

  @Patch(':id/fields/reorder')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  reorderFields(
    @Param('id') id: string,
    @CurrentUser() u: JwtUser,
    @Body() body: { order: { id: string; order: number }[] },
  ) {
    return this.taskTypesService.reorderFields(id, body.order, u.roles, u.sectionId);
  }

  @Post(':id/fields')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  createField(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body() dto: CreateFormFieldDto) {
    return this.taskTypesService.createField(id, dto, u.roles, u.sectionId);
  }

  @Patch(':id/fields/:fieldId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  updateField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
    @CurrentUser() u: JwtUser,
    @Body() dto: UpdateFormFieldDto,
  ) {
    return this.taskTypesService.updateField(id, fieldId, dto, u.roles, u.sectionId);
  }

  @Delete(':id/fields/:fieldId')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  removeField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
    @CurrentUser() u: JwtUser,
  ) {
    return this.taskTypesService.removeField(id, fieldId, u.roles, u.sectionId);
  }
}
