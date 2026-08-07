import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountRole, ExecutionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddStepWebhookDto } from './dto/add-step-webhook.dto';
import { CreateFormFieldDto } from './dto/create-form-field.dto';
import { CreateStepDto } from './dto/create-step.dto';
import { CreateTaskTypeDto } from './dto/create-task-type.dto';
import { UpdateFormFieldDto } from './dto/update-form-field.dto';
import { UpdateStepDto } from './dto/update-step.dto';
import { UpdateTaskTypeDto } from './dto/update-task-type.dto';
import { SectionAccessService } from '../sections/section-access.service';

const TASK_TYPE_INCLUDE = {
  stepDefinitions: {
    orderBy: { order: 'asc' as const },
    include: {
      handler: { select: { id: true, name: true } },
      stepWebhooks: { include: { webhook: { select: { id: true, name: true, url: true } } } },
      candidates: { include: { account: { select: { id: true, name: true, email: true } } } },
    },
  },
  formFields: {
    orderBy: { order: 'asc' as const },
    include: { filteredBy: { select: { id: true, label: true } } },
  },
  templates: { orderBy: { createdAt: 'asc' as const } },
  section: { select: { id: true, name: true } },
} as const;

@Injectable()
export class TaskTypesService {
  constructor(private prisma: PrismaService, private sectionAccess: SectionAccessService) {}

  // ── TaskType ──────────────────────────────────────────────────────────────

  async findAll(
    roles: AccountRole[],
    sectionId: string | null,
    { page = 1, limit = 50, q }: { page?: number; limit?: number; q?: string } = {},
  ) {
    const allowedSectionIds = await this.sectionAccess.accessibleSectionIds(roles);

    const where = {
      deletedAt: null,
      ...(allowedSectionIds !== null && { sectionId: { in: allowedSectionIds } }),
      ...(q && { name: { contains: q, mode: 'insensitive' as const } }),
    };

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.taskType.findMany({
        where,
        select: {
          id: true,
          name: true,
          descripcion: true,
          active: true,
          schedulable: true,
          order: true,
          sectionId: true,
          section: { select: { id: true, name: true, order: true } },
          _count: { select: { stepDefinitions: true, formFields: true, tasks: true } },
        },
        orderBy: [{ section: { order: 'asc' } }, { order: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.taskType.count({ where }),
    ]);
    const mapped = data.map(({ descripcion, ...rest }) => ({ ...rest, description: descripcion }));
    return { data: mapped, total, page, limit };
  }

  async findOne(id: string) {
    const tt = await this.prisma.taskType.findUnique({
      where: { id },
      include: TASK_TYPE_INCLUDE,
    });
    if (!tt || tt.deletedAt) throw new NotFoundException('TaskType not found');
    return tt;
  }

  async findOneForUser(id: string, roles: AccountRole[]) {
    const taskType = await this.findOne(id);
    if (!(await this.sectionAccess.canAccess(roles, taskType.sectionId))) {
      throw new ForbiddenException('You do not have access to this task type');
    }
    return taskType;
  }

  async create(dto: CreateTaskTypeDto, roles: AccountRole[], sectionId: string | null) {
    this.assertAdminOfSection(roles, sectionId, dto.sectionId);
    const { description, ...rest } = dto;
    const aggregate = await this.prisma.taskType.aggregate({ where: { sectionId: dto.sectionId }, _max: { order: true } });
    return this.prisma.taskType.create({
      data: { ...rest, descripcion: description, order: (aggregate._max.order ?? -1) + 1 },
      include: TASK_TYPE_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateTaskTypeDto, roles: AccountRole[], sectionId: string | null) {
    const tt = await this.assertTaskTypeAccess(id, roles, sectionId);
    const { description, sectionId: targetSectionId, ...rest } = dto;
    const movingSections = targetSectionId !== undefined && targetSectionId !== tt.sectionId;
    if (movingSections) {
      this.assertAdminOfSection(roles, sectionId, targetSectionId);
      const target = await this.prisma.section.findUnique({
        where: { id: targetSectionId }, select: { id: true },
      });
      if (!target) throw new BadRequestException('Target section does not exist');
    }
    return this.prisma.$transaction(async tx => {
      const targetOrder = movingSections
        ? ((await tx.taskType.aggregate({
            where: { sectionId: targetSectionId, deletedAt: null },
            _max: { order: true },
          }))._max.order ?? -1) + 1
        : undefined;
      return tx.taskType.update({
        where: { id: tt.id },
        data: {
          ...rest,
          ...(description !== undefined && { descripcion: description }),
          ...(movingSections && { sectionId: targetSectionId, order: targetOrder }),
        },
        include: TASK_TYPE_INCLUDE,
      });
    });
  }

  async toggleActive(id: string, roles: AccountRole[], sectionId: string | null) {
    const tt = await this.assertTaskTypeAccess(id, roles, sectionId);
    return this.prisma.taskType.update({
      where: { id: tt.id },
      data: { active: !tt.active },
      include: TASK_TYPE_INCLUDE,
    });
  }

  async remove(id: string, roles: AccountRole[], sectionId: string | null) {
    const tt = await this.assertTaskTypeAccess(id, roles, sectionId);
    return this.prisma.taskType.update({
      where: { id: tt.id },
      data: { deletedAt: new Date() },
    });
  }

  async copyTaskType(id: string, roles: AccountRole[], sectionId: string | null) {
    const source = await this.findOne(id);
    this.assertAdminOfSection(roles, sectionId, source.sectionId);

    return this.prisma.$transaction(async (tx) => {
      const aggregate = await tx.taskType.aggregate({ where: { sectionId: source.sectionId }, _max: { order: true } });
      const newTT = await tx.taskType.create({
        data: {
          sectionId: source.sectionId,
          name: `${source.name} (copy)`,
          descripcion: (source as any).descripcion ?? null,
          schedulable: source.schedulable,
          active: false,
          order: (aggregate._max.order ?? -1) + 1,
        },
      });

      for (const field of source.formFields ?? []) {
        await tx.formField.create({
          data: {
            taskTypeId: newTT.id,
            label: field.label,
            tipo: field.tipo as any,
            required: field.required,
            multiple: field.multiple ?? false,
            options: field.options as any ?? undefined,
            order: field.order,
          },
        });
      }

      for (const step of source.stepDefinitions ?? []) {
        const newStep = await tx.stepDefinition.create({
          data: {
            taskTypeId: newTT.id,
            name: step.name,
            order: step.order,
            executionType: step.executionType,
            action: (step as any).action ?? null,
            assignmentStrategy: step.assignmentStrategy,
            weight: (step as any).weight ?? 1,
            handlerId: step.handlerId ?? null,
            bpoCount: (step as any).bpoCount ?? 1,
          },
        });

        if (step.candidates?.length) {
          await tx.stepDefinitionAccount.createMany({
            data: step.candidates.map(c => ({
              stepDefinitionId: newStep.id,
              accountId: c.account.id,
            })),
          });
        }

        for (const sw of step.stepWebhooks ?? []) {
          await tx.stepWebhook.create({
            data: {
              stepDefinitionId: newStep.id,
              webhookId: sw.webhookId,
              events: sw.events,
            },
          });
        }
      }

      for (const tmpl of source.templates ?? []) {
        await tx.taskTypeTemplate.create({
          data: {
            taskTypeId: newTT.id,
            name: tmpl.name,
            url: tmpl.url,
            tipo: tmpl.tipo,
          },
        });
      }

      return tx.taskType.findUnique({ where: { id: newTT.id }, include: TASK_TYPE_INCLUDE });
    });
  }

  async reorderTaskTypes(order: { id: string; order: number }[]) {
    const uniqueIds = [...new Set(order.map(item => item.id))];
    if (uniqueIds.length !== order.length || order.some(item => !Number.isInteger(item.order) || item.order < 0)) {
      throw new BadRequestException('Task order must contain unique IDs and non-negative integer positions');
    }
    const count = await this.prisma.taskType.count({ where: { id: { in: uniqueIds }, deletedAt: null } });
    if (count !== uniqueIds.length) throw new BadRequestException('One or more task types do not exist');
    await this.prisma.$transaction(order.map(item => this.prisma.taskType.update({ where: { id: item.id }, data: { order: item.order } })));
    return { updated: order.length };
  }

  // ── StepDefinition ────────────────────────────────────────────────────────

  async createStep(taskTypeId: string, dto: CreateStepDto, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    this.validateHandler(dto.executionType, dto.handlerId);
    return this.prisma.stepDefinition.create({ data: { taskTypeId, ...dto } });
  }

  async updateStep(taskTypeId: string, stepId: string, dto: UpdateStepDto, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    const step = await this.assertStepBelongs(stepId, taskTypeId);
    const nextType = dto.executionType ?? step.executionType;
    const nextHandler = 'handlerId' in dto ? dto.handlerId : step.handlerId ?? undefined;
    this.validateHandler(nextType, nextHandler);
    return this.prisma.stepDefinition.update({ where: { id: stepId }, data: dto });
  }

  async reorderSteps(taskTypeId: string, order: { id: string; order: number }[], roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    // Use large temporary offsets to avoid unique constraint conflicts mid-transaction
    await this.prisma.$transaction([
      ...order.map(({ id, order: o }) =>
        this.prisma.stepDefinition.update({ where: { id }, data: { order: o + 10000 } })
      ),
      ...order.map(({ id, order: o }) =>
        this.prisma.stepDefinition.update({ where: { id }, data: { order: o } })
      ),
    ]);
  }

  async removeStep(taskTypeId: string, stepId: string, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    await this.prisma.$transaction([
      this.prisma.stepInstance.deleteMany({ where: { stepDefinitionId: stepId } }),
      this.prisma.stepDefinition.delete({ where: { id: stepId } }),
    ]);
  }

  // ── Step candidates ───────────────────────────────────────────────────────

  async addCandidate(taskTypeId: string, stepId: string, accountId: string, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepDefinitionAccount.create({
      data: { stepDefinitionId: stepId, accountId },
    });
  }

  async removeCandidate(taskTypeId: string, stepId: string, accountId: string, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepDefinitionAccount.delete({
      where: { stepDefinitionId_accountId: { stepDefinitionId: stepId, accountId } },
    });
  }

  // ── StepWebhook ───────────────────────────────────────────────────────────

  async addStepWebhook(taskTypeId: string, stepId: string, dto: AddStepWebhookDto, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    const existing = await this.prisma.stepWebhook.findUnique({
      where: { stepDefinitionId_webhookId: { stepDefinitionId: stepId, webhookId: dto.webhookId } },
    });
    if (existing) throw new ConflictException('This webhook is already configured on this step');
    return this.prisma.stepWebhook.create({
      data: { stepDefinitionId: stepId, webhookId: dto.webhookId, events: dto.events },
    });
  }

  async removeStepWebhook(taskTypeId: string, stepId: string, stepWebhookId: string, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertStepBelongs(stepId, taskTypeId);
    return this.prisma.stepWebhook.delete({ where: { id: stepWebhookId } });
  }

  // ── FormField ─────────────────────────────────────────────────────────────

  async reorderFields(taskTypeId: string, order: { id: string; order: number }[], roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.prisma.$transaction([
      ...order.map(({ id, order: o }) =>
        this.prisma.formField.update({ where: { id }, data: { order: o + 10000 } })
      ),
      ...order.map(({ id, order: o }) =>
        this.prisma.formField.update({ where: { id }, data: { order: o } })
      ),
    ]);
  }

  async createField(taskTypeId: string, dto: CreateFormFieldDto, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    const { options, type, ...rest } = dto;
    return this.prisma.formField.create({
      data: { taskTypeId, ...rest, tipo: type, ...(options !== undefined && { options }) },
    });
  }

  async updateField(taskTypeId: string, fieldId: string, dto: UpdateFormFieldDto, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertFieldBelongs(fieldId, taskTypeId);
    const { options, filteredById, type, ...rest } = dto;
    return this.prisma.formField.update({
      where: { id: fieldId },
      data: {
        ...rest,
        ...(type !== undefined && { tipo: type }),
        ...(options !== undefined && { options }),
        ...(filteredById !== undefined && { filteredById }),
      },
    });
  }

  async removeField(taskTypeId: string, fieldId: string, roles: AccountRole[], sectionId: string | null) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    await this.assertFieldBelongs(fieldId, taskTypeId);
    return this.prisma.$transaction([
      this.prisma.formValue.deleteMany({ where: { formFieldId: fieldId } }),
      this.prisma.formField.delete({ where: { id: fieldId } }),
    ]);
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async addTemplate(
    taskTypeId: string,
    dto: { name: string; url: string; tipo?: string },
    roles: AccountRole[],
    sectionId: string | null,
  ) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    return this.prisma.taskTypeTemplate.create({
      data: { taskTypeId, name: dto.name, url: dto.url, tipo: dto.tipo ?? 'link' },
    });
  }

  async removeTemplate(
    taskTypeId: string,
    templateId: string,
    roles: AccountRole[],
    sectionId: string | null,
  ) {
    await this.assertTaskTypeAccess(taskTypeId, roles, sectionId);
    const tmpl = await this.prisma.taskTypeTemplate.findUnique({ where: { id: templateId } });
    if (!tmpl || tmpl.taskTypeId !== taskTypeId) throw new NotFoundException('Template not found');
    return this.prisma.taskTypeTemplate.delete({ where: { id: templateId } });
  }

  // ── Internal guards ───────────────────────────────────────────────────────

  private assertAdminOfSection(roles: AccountRole[], sectionId: string | null, targetSectionId: string) {
    if (roles.includes(AccountRole.super_admin)) return;
    if (roles.includes(AccountRole.admin) && sectionId === targetSectionId) return;
    throw new ForbiddenException('No access to this section');
  }

  private async assertTaskTypeAccess(id: string, roles: AccountRole[], sectionId: string | null) {
    const tt = await this.prisma.taskType.findUnique({ where: { id } });
    if (!tt || tt.deletedAt) throw new NotFoundException('TaskType not found');
    this.assertAdminOfSection(roles, sectionId, tt.sectionId);
    return tt;
  }

  private async assertStepBelongs(stepId: string, taskTypeId: string) {
    const step = await this.prisma.stepDefinition.findUnique({ where: { id: stepId } });
    if (!step || step.taskTypeId !== taskTypeId) throw new NotFoundException('Step not found');
    return step;
  }

  private async assertFieldBelongs(fieldId: string, taskTypeId: string) {
    const field = await this.prisma.formField.findUnique({ where: { id: fieldId } });
    if (!field || field.taskTypeId !== taskTypeId) throw new NotFoundException('Field not found');
    return field;
  }

  private validateHandler(type: ExecutionType, handlerId?: string) {
    if (type !== ExecutionType.automatic && handlerId) {
      throw new BadRequestException('Only automatic steps can have a handler');
    }
    if (type === ExecutionType.automatic && !handlerId) {
      throw new BadRequestException('Automatic steps require a handler');
    }
  }
}
