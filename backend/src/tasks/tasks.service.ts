import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, ExecutionType, Prisma, StepFailureReason, StepStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from './task-engine.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { TaskValidationService } from './task-validation.service';

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
    private validation: TaskValidationService,
  ) {}

  // ── Create task ───────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto, user: JwtUser) {
    await this.validation.assertTaskTypeAccess(dto.taskTypeId, user);
    const createdById = user.id;
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

      // StepInstances — create bpoCount instances for fixed/manual, 1 for others
      if (taskType.stepDefinitions.length > 0) {
        await tx.stepInstance.createMany({
          data: taskType.stepDefinitions.flatMap((sd) => {
            const count =
              sd.assignmentStrategy === 'fixed' || sd.assignmentStrategy === 'manual'
                ? (sd.bpoCount ?? 1)
                : 1;
            return Array.from({ length: count }, () => ({
              taskId: created.id,
              stepDefinitionId: sd.id,
            }));
          }),
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

    // Activate first step(s) if not scheduled — advanceTask handles multiple bpoCount instances
    if (!isScheduled && taskType.stepDefinitions.length > 0) {
      await this.engine.advanceTask(task.id);
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

  async getStepExport(
    taskId: string,
    stepId: string,
    viewer: { roles: AccountRole[]; accountId: string; sectionId: string | null },
    format: 'xlsx' | 'json' = 'xlsx',
  ): Promise<{ fileKey: string; mimeType: string }> {
    const task = await this.findOne(taskId, viewer);
    const step = task.stepInstances.find((item) => item.id === stepId);
    if (!step) throw new NotFoundException('Step not found in this task');

    const result = step.result as { fileKey?: unknown; jsonFileKey?: unknown } | null;
    const fileKey = format === 'json' ? result?.jsonFileKey : result?.fileKey;
    const validFilename = format === 'json'
      ? /^store-menu-[a-zA-Z0-9_-]+\.json$/
      : /^(?:shops|store-menu|brand-menu)-[a-zA-Z0-9_-]+\.xlsx$/;
    if (step.status !== 'done' || typeof fileKey !== 'string' ||
        !validFilename.test(fileKey)) {
      throw new NotFoundException('Export file not found');
    }
    return {
      fileKey,
      mimeType: format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  // ── Step actions ──────────────────────────────────────────────────────────

  async assignStep(taskId: string, stepId: string, accountId: string, requester: JwtUser) {
    const viewer = {
      roles: requester.roles,
      accountId: requester.id,
      sectionId: requester.sectionId,
    };
    const task = await this.findOne(taskId, viewer);
    const step = task.stepInstances.find((item) => item.id === stepId);
    if (!step) throw new NotFoundException('Step not found in this task');
    if (step.stepDefinition.executionType === ExecutionType.automatic) {
      throw new BadRequestException('Automatic steps cannot be assigned to a BPO');
    }
    if (step.status !== StepStatus.pending &&
        step.status !== StepStatus.in_progress &&
        step.status !== StepStatus.blocked) {
      throw new BadRequestException('Only active human steps can be reassigned');
    }
    if (step.assignedToId === accountId) {
      throw new BadRequestException('The selected BPO is already assigned to this step');
    }

    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);
    const target = await this.prisma.account.findFirst({
      where: {
        id: accountId,
        deletedAt: null,
        roles: { has: AccountRole.bpo },
        ...(!isSuperAdmin ? { sectionId: requester.sectionId ?? undefined } : {}),
      },
      select: { id: true },
    });
    if (!target) {
      throw new BadRequestException('Selected account is not an available BPO in your section');
    }

    await this.engine.assignOrReassignStep(stepId, accountId);
    return this.findOne(taskId, viewer);
  }

  async completeStep(taskId: string, stepId: string, result: unknown, note: string | undefined, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester);
    await this.engine.completeStep(stepId, result, note);
    return this.findOne(taskId, viewer);
  }

  async failStep(taskId: string, stepId: string, failureReason: StepFailureReason, note: string | undefined, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester);
    await this.engine.failStep(stepId, failureReason, note);
    return this.findOne(taskId, viewer);
  }

  async blockStep(taskId: string, stepId: string, note: string | undefined, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester);
    await this.engine.blockStep(stepId, note);
    return this.findOne(taskId, viewer);
  }

  async retryStep(taskId: string, stepId: string, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester);
    await this.engine.retryStep(stepId);
    return this.findOne(taskId, viewer);
  }

  async forceRetryStep(taskId: string, stepId: string, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester, true);
    await this.engine.forceRetryStep(stepId);
    return this.findOne(taskId, viewer);
  }

  async startStep(taskId: string, stepId: string, requester: JwtUser) {
    const viewer = await this.assertCanActOnStep(taskId, stepId, requester);
    await this.engine.startStep(stepId);
    return this.findOne(taskId, viewer);
  }

  private async assertCanActOnStep(
    taskId: string,
    stepId: string,
    requester: JwtUser,
    adminOnly = false,
  ) {
    const viewer = {
      roles: requester.roles,
      accountId: requester.id,
      sectionId: requester.sectionId,
    };
    const task = await this.findOne(taskId, viewer);
    const step = task.stepInstances.find((item) => item.id === stepId);
    if (!step) throw new NotFoundException('Step not found in this task');

    const isAdmin = requester.roles.includes(AccountRole.admin) ||
      requester.roles.includes(AccountRole.super_admin);
    if (adminOnly && !isAdmin) throw new ForbiddenException('Only admins can perform this action');
    if (!isAdmin && step.assignedToId !== requester.id) {
      throw new ForbiddenException('This step is assigned to another BPO');
    }
    return viewer;
  }
}
