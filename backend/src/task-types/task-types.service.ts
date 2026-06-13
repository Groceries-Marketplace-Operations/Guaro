import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountRol, TipoEjecucion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddStepWebhookDto } from './dto/add-step-webhook.dto';
import { CreateFormFieldDto } from './dto/create-form-field.dto';
import { CreateStepDto } from './dto/create-step.dto';
import { CreateTaskTypeDto } from './dto/create-task-type.dto';
import { UpdateFormFieldDto } from './dto/update-form-field.dto';
import { UpdateStepDto } from './dto/update-step.dto';
import { UpdateTaskTypeDto } from './dto/update-task-type.dto';

const TASK_TYPE_INCLUDE = {
  stepDefinitions: {
    orderBy: { orden: 'asc' as const },
    include: {
      handler: { select: { id: true, nombre: true } },
      stepWebhooks: { include: { webhook: { select: { id: true, nombre: true, url: true } } } },
      candidatos: { include: { account: { select: { id: true, nombre: true, email: true } } } },
    },
  },
  formFields: {
    orderBy: { orden: 'asc' as const },
    include: { filtraPor: { select: { id: true, etiqueta: true } } },
  },
  section: { select: { id: true, nombre: true } },
} as const;

@Injectable()
export class TaskTypesService {
  constructor(private prisma: PrismaService) {}

  // ── TaskType ──────────────────────────────────────────────────────────────

  findAll(roles: AccountRol[], sectionId: string | null) {
    const where = roles.includes(AccountRol.super_admin)
      ? { deletedAt: null }
      : { deletedAt: null, sectionId: sectionId ?? undefined };

    return this.prisma.taskType.findMany({
      where,
      include: TASK_TYPE_INCLUDE,
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: string) {
    const tt = await this.prisma.taskType.findUnique({
      where: { id },
      include: TASK_TYPE_INCLUDE,
    });
    if (!tt || tt.deletedAt) throw new NotFoundException('TaskType no encontrado');
    return tt;
  }

  async create(dto: CreateTaskTypeDto, roles: AccountRol[], sectionId: string | null) {
    this.assertAdminOfSection(roles, sectionId, dto.sectionId);
    return this.prisma.taskType.create({ data: dto, include: TASK_TYPE_INCLUDE });
  }

  async update(id: string, dto: UpdateTaskTypeDto, roles: AccountRol[], sectionId: string | null) {
    const tt = await this.assertTaskTypeAccess(id, roles, sectionId);
    return this.prisma.taskType.update({ where: { id: tt.id }, data: dto, include: TASK_TYPE_INCLUDE });
  }

  async remove(id: string, roles: AccountRol[], sectionId: string | null) {
    const tt = await this.assertTaskTypeAccess(id, roles, sectionId);
    return this.prisma.taskType.update({
      where: { id: tt.id },
      data: { deletedAt: new Date() },
    });
  }

  // ── StepDefinition ────────────────────────────────────────────────────────

  async createStep(taskTypeId: string, dto: CreateStepDto, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    this.validateHandler(dto.tipoEjecucion, dto.handlerId);
    return this.prisma.stepDefinition.create({ data: { taskTypeId, ...dto } });
  }

  async updateStep(taskTypeId: string, stepId: string, dto: UpdateStepDto, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    const step = await this.assertStepBelongs(stepId, taskTypeId);
    const nextTipo = dto.tipoEjecucion ?? step.tipoEjecucion;
    const nextHandler = 'handlerId' in dto ? dto.handlerId : step.handlerId ?? undefined;
    this.validateHandler(nextTipo, nextHandler);
    return this.prisma.stepDefinition.update({ where: { id: stepId }, data: dto });
  }

  async removeStep(taskTypeId: string, stepId: string, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepDefinition.delete({ where: { id: stepId } });
  }

  // ── Candidatos de step ────────────────────────────────────────────────────

  async addCandidate(taskTypeId: string, stepId: string, accountId: string, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepDefinitionAccount.create({
      data: { stepDefinitionId: stepId, accountId },
    });
  }

  async removeCandidate(taskTypeId: string, stepId: string, accountId: string, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepDefinitionAccount.delete({
      where: { stepDefinitionId_accountId: { stepDefinitionId: stepId, accountId } },
    });
  }

  // ── StepWebhook ───────────────────────────────────────────────────────────

  async addStepWebhook(taskTypeId: string, stepId: string, dto: AddStepWebhookDto, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepWebhook.create({
      data: { stepDefinitionId: stepId, webhookId: dto.webhookId, eventos: dto.eventos },
    });
  }

  async removeStepWebhook(taskTypeId: string, stepId: string, stepWebhookId: string, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepWebhook.delete({ where: { id: stepWebhookId } });
  }

  // ── FormField ─────────────────────────────────────────────────────────────

  async createField(taskTypeId: string, dto: CreateFormFieldDto, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    const { opciones, ...rest } = dto;
    return this.prisma.formField.create({
      data: { taskTypeId, ...rest, opciones: opciones ?? null },
    });
  }

  async updateField(taskTypeId: string, fieldId: string, dto: UpdateFormFieldDto, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertFieldBelongs(fieldId, taskTypeId);
    const { opciones, filtraPorId, ...rest } = dto;
    return this.prisma.formField.update({
      where: { id: fieldId },
      data: {
        ...rest,
        ...(opciones !== undefined && { opciones }),
        ...(filtraPorId !== undefined && { filtraPorId }),
      },
    });
  }

  async removeField(taskTypeId: string, fieldId: string, roles: AccountRol[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertFieldBelongs(fieldId, taskTypeId);
    return this.prisma.formField.delete({ where: { id: fieldId } });
  }

  // ── Guards internos ───────────────────────────────────────────────────────

  private assertAdminOfSection(roles: AccountRol[], sectionId: string | null, targetSectionId: string) {
    if (roles.includes(AccountRol.super_admin)) return;
    if (roles.includes(AccountRol.admin) && sectionId === targetSectionId) return;
    throw new ForbiddenException('Sin acceso a esta section');
  }

  private async assertTaskTypeAccess(id: string, roles: AccountRol[], sectionId: string | null) {
    const tt = await this.prisma.taskType.findUnique({ where: { id } });
    if (!tt || tt.deletedAt) throw new NotFoundException('TaskType no encontrado');
    this.assertAdminOfSection(roles, sectionId, tt.sectionId);
    return tt;
  }

  private async assertStepBelongs(stepId: string, taskTypeId: string) {
    const step = await this.prisma.stepDefinition.findUnique({ where: { id: stepId } });
    if (!step || step.taskTypeId !== taskTypeId) throw new NotFoundException('Step no encontrado');
    return step;
  }

  private async assertFieldBelongs(fieldId: string, taskTypeId: string) {
    const field = await this.prisma.formField.findUnique({ where: { id: fieldId } });
    if (!field || field.taskTypeId !== taskTypeId) throw new NotFoundException('Campo no encontrado');
    return field;
  }

  private validateHandler(tipo: TipoEjecucion, handlerId?: string) {
    if (tipo !== TipoEjecucion.automatico && handlerId) {
      throw new BadRequestException('Solo los steps automáticos pueden tener handler');
    }
    if (tipo === TipoEjecucion.automatico && !handlerId) {
      throw new BadRequestException('Los steps automáticos requieren un handler');
    }
  }
}
