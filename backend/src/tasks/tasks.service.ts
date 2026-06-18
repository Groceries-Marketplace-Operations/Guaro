import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, ExecutionType, Prisma, StepFailureReason, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from './task-engine.service';
import { CreateTaskDto } from './dto/create-task.dto';

const TASK_INCLUDE = {
  taskType: { select: { id: true, name: true, sectionId: true } },
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  stepInstances: {
    orderBy: { stepDefinition: { order: 'asc' as const } },
    include: {
      stepDefinition: { select: { id: true, name: true, order: true, executionType: true, assignmentStrategy: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  },
  formValues: {
    include: {
      formField: { select: { id: true, label: true, tipo: true } },
      brand: { select: { id: true, brandId: true, brandName: true } },
      shop: { select: { id: true, shopId: true, appShopId: true } },
    },
  },
  taskShops: { include: { shop: { select: { id: true, shopId: true, appShopId: true } } } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private engine: TaskEngineService,
  ) {}

  // ── Create task ───────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto, createdById: string) {
    const taskType = await this.prisma.taskType.findUnique({
      where: { id: dto.taskTypeId },
      include: { stepDefinitions: { orderBy: { order: 'asc' } } },
    });
    if (!taskType || taskType.deletedAt) throw new NotFoundException('TaskType not found');

    const isScheduled = !!dto.scheduledStart;
    if (isScheduled && !taskType.schedulable) {
      throw new BadRequestException('This TaskType is not schedulable');
    }

    // Derive brandId from a select_brand formValue if not provided directly
    const resolvedBrandId =
      dto.brandId ?? dto.formValues?.find((fv) => fv.brandId)?.brandId ?? null;

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          taskTypeId: dto.taskTypeId,
          brandId: resolvedBrandId,
          createdById,
          status: isScheduled ? TaskStatus.scheduled : TaskStatus.pending,
          scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : null,
          scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null,
        },
      });

      // StepInstances
      if (taskType.stepDefinitions.length > 0) {
        await tx.stepInstance.createMany({
          data: taskType.stepDefinitions.map((sd) => ({
            taskId: created.id,
            stepDefinitionId: sd.id,
          })),
        });
      }

      // FormValues
      if (dto.formValues?.length) {
        await tx.formValue.createMany({
          data: dto.formValues.map(({ value, ...fv }) => ({ taskId: created.id, ...fv, valor: value })),
        });
      }

      // TaskShops
      if (dto.shopIds?.length) {
        await tx.taskShop.createMany({
          data: dto.shopIds.map((shopId) => ({ taskId: created.id, shopId })),
        });
      }

      return created;
    });

    // Activate first step if not scheduled
    if (!isScheduled && taskType.stepDefinitions.length > 0) {
      const firstStep = await this.prisma.stepInstance.findFirst({
        where: { taskId: task.id },
        include: { stepDefinition: true },
        orderBy: { stepDefinition: { order: 'asc' } },
      });
      if (firstStep) {
        await this.engine.activateStep(firstStep.id);
        if (firstStep.stepDefinition.executionType === ExecutionType.automatic) {
          this.engine.emitAutoStep(firstStep.id, firstStep.stepDefinition.handlerId!, task.id);
        }
      }
    }

    return this.findOne(task.id);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findAll(
    roles: AccountRole[],
    accountId: string,
    sectionId: string | null,
    filters: { page?: number; limit?: number; q?: string; status?: TaskStatus; brandId?: string } = {},
  ) {
    const { page = 1, limit = 25, q, status, brandId } = filters;
    const skip = (page - 1) * limit;

    const AND: Prisma.TaskWhereInput[] = [{ deletedAt: null }];

    // Role-based visibility
    const isSuperAdmin = roles.includes(AccountRole.super_admin);
    const isAdmin      = roles.includes(AccountRole.admin);
    const isBpo        = roles.includes(AccountRole.bpo);
    const isUser       = roles.includes(AccountRole.user);

    if (!isSuperAdmin && !isAdmin) {
      if (isUser && !isBpo) {
        AND.push({ createdById: accountId });
      } else if (isBpo && !isUser) {
        AND.push({ stepInstances: { some: { assignedToId: accountId } } });
      }
      // user+bpo or director: no additional restriction
    } else if (isAdmin && !isSuperAdmin) {
      AND.push({ taskType: { sectionId: sectionId ?? undefined } });
    }

    if (status)  AND.push({ status });
    if (brandId) AND.push({ brandId });
    if (q) AND.push({
      OR: [
        { brand:    { brandName: { contains: q, mode: 'insensitive' } } },
        { taskType: { name:      { contains: q, mode: 'insensitive' } } },
      ],
    });

    const where: Prisma.TaskWhereInput = { AND };

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: TASK_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.task.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(
    id: string,
    viewer?: { roles: AccountRole[]; accountId: string; sectionId: string | null },
  ) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) throw new NotFoundException('Task not found');

    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task || task.deletedAt) throw new NotFoundException('Task not found');

    if (viewer) {
      const { roles, accountId, sectionId } = viewer;
      const isSuperAdmin = roles.includes(AccountRole.super_admin);
      const isAdmin      = roles.includes(AccountRole.admin);
      const isBpo        = roles.includes(AccountRole.bpo);
      const isUser       = roles.includes(AccountRole.user);
      const isDirector   = roles.includes(AccountRole.director);

      if (!isSuperAdmin && !isAdmin && !isDirector) {
        if (isUser && !isBpo) {
          if (task.createdById !== accountId) throw new ForbiddenException('Task not found');
        } else if (isBpo && !isUser) {
          const assigned = task.stepInstances.some((s: { assignedToId: string | null }) => s.assignedToId === accountId);
          if (!assigned) throw new ForbiddenException('Task not found');
        }
      } else if (isAdmin && !isSuperAdmin) {
        const taskSectionId = (task as { taskType?: { sectionId?: string } }).taskType?.sectionId;
        if (taskSectionId && taskSectionId !== sectionId) throw new ForbiddenException('Task not found');
      }
    }

    return task;
  }

  // ── Step actions ──────────────────────────────────────────────────────────

  async completeStep(taskId: string, stepId: string, result?: unknown, note?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.completeStep(stepId, result, note);
    return this.findOne(taskId);
  }

  async failStep(taskId: string, stepId: string, failureReason: StepFailureReason, note?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.failStep(stepId, failureReason, note);
    return this.findOne(taskId);
  }

  async blockStep(taskId: string, stepId: string, note?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.blockStep(stepId, note);
    return this.findOne(taskId);
  }

  async retryStep(taskId: string, stepId: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.retryStep(stepId);
    return this.findOne(taskId);
  }

  async startStep(taskId: string, stepId: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.startStep(stepId);
    return this.findOne(taskId);
  }

  private async assertStepOfTask(taskId: string, stepId: string) {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepId } });
    if (!step || step.taskId !== taskId) throw new NotFoundException('Step not found in this task');
  }
}
