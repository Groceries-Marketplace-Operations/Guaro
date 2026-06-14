import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
      stepDefinition: { select: { id: true, name: true, order: true, executionType: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  },
  formValues: { include: { formField: { select: { id: true, label: true, tipo: true } } } },
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

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          taskTypeId: dto.taskTypeId,
          brandId: dto.brandId ?? null,
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
          this.engine.emitAutoStep(firstStep.id, firstStep.stepDefinition.handlerId!);
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

    const where: Prisma.TaskWhereInput = { deletedAt: null };
    if (roles.includes(AccountRole.user) && !roles.includes(AccountRole.admin) && !roles.includes(AccountRole.super_admin)) {
      where.createdById = accountId;
    } else if (roles.includes(AccountRole.bpo) && !roles.includes(AccountRole.admin) && !roles.includes(AccountRole.super_admin)) {
      where.stepInstances = { some: { assignedToId: accountId } };
    } else if (roles.includes(AccountRole.admin) && !roles.includes(AccountRole.super_admin)) {
      where.taskType = { sectionId: sectionId ?? undefined };
    }
    if (status) where.status = status;
    if (brandId) where.brandId = brandId;
    if (q) where.OR = [
      { brand:    { brandName: { contains: q, mode: 'insensitive' } } },
      { taskType: { name:      { contains: q, mode: 'insensitive' } } },
    ];

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: TASK_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.task.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task || task.deletedAt) throw new NotFoundException('Task not found');
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

  private async assertStepOfTask(taskId: string, stepId: string) {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepId } });
    if (!step || step.taskId !== taskId) throw new NotFoundException('Step not found in this task');
  }
}
