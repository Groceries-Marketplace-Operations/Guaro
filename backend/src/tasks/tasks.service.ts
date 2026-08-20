import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, ExecutionType, Prisma, StepFailureReason, StepStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from './task-engine.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { TaskValidationService } from './task-validation.service';
import { SectionAccessService } from '../sections/section-access.service';

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

// Task lists only render the step status, active step and assignee. Notes,
// results and form payloads stay in the detail query so large execution logs
// are not transferred on every Tasks, Dashboard and Brand request.
const TASK_LIST_INCLUDE = {
  taskType: { select: { id: true, name: true, sectionId: true } },
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  stepInstances: {
    orderBy: { stepDefinition: { order: 'asc' as const } },
    select: {
      id: true,
      status: true,
      assignedToId: true,
      stepDefinition: {
        select: {
          id: true,
          name: true,
          order: true,
          executionType: true,
          assignmentStrategy: true,
        },
      },
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private engine: TaskEngineService,
    private validation: TaskValidationService,
    private sectionAccess: SectionAccessService,
  ) {}

  // ── Create task ───────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto, user: JwtUser) {
    await this.validation.assertTaskTypeAccess(dto.taskTypeId, user);
    const createdById = user.id;
    const taskType = await this.prisma.taskType.findUnique({
      where: { id: dto.taskTypeId },
      include: {
        stepDefinitions: {
          orderBy: { order: 'asc' },
          include: { handler: { select: { name: true } } },
        },
      },
    });
    if (!taskType || taskType.deletedAt) throw new NotFoundException('TaskType not found');

    const isScheduled = !!dto.scheduledStart;
    if (isScheduled && !taskType.schedulable) {
      throw new BadRequestException('This TaskType is not schedulable');
    }

    // Derive brandId from a select_brand formValue if not provided directly
    const resolvedBrandId =
      dto.brandId ?? dto.formValues?.find((fv) => fv.brandId)?.brandId ?? null;
    const isCommercialMenu = taskType.stepDefinitions.some(
      definition => definition.handler?.name === 'commercial_menu_upload',
    );
    let resolvedShopIds = [...new Set(dto.shopIds ?? [])];

    if (dto.shopScope === 'all') {
      if (!resolvedBrandId) throw new BadRequestException('A brand is required to select all stores');
      const shops = await this.prisma.shop.findMany({
        where: { brandId: resolvedBrandId, deletedAt: null },
        select: { id: true },
      });
      resolvedShopIds = shops.map(shop => shop.id);
    }

    if (resolvedShopIds.length) {
      if (!resolvedBrandId) throw new BadRequestException('A brand is required when stores are selected');
      const validShops = await this.prisma.shop.findMany({
        where: { id: { in: resolvedShopIds }, brandId: resolvedBrandId, deletedAt: null },
        select: { id: true },
      });
      if (validShops.length !== resolvedShopIds.length) {
        throw new BadRequestException('One or more selected stores do not belong to the selected brand');
      }
    }

    if (isCommercialMenu) {
      if (!resolvedBrandId) throw new BadRequestException('Brand is required for this task');
      if (!resolvedShopIds.length) throw new BadRequestException('Select at least one target store');
      const categoryCount = await this.prisma.brandMenuCategory.count({
        where: { brandId: resolvedBrandId, active: true },
      });
      if (!categoryCount) throw new BadRequestException('Configure the brand menu categories before creating this task');
    }

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
      if (resolvedShopIds.length) {
        await tx.taskShop.createMany({
          data: resolvedShopIds.map((shopId) => ({ taskId: created.id, shopId })),
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
    filters: { page?: number; limit?: number; q?: string; status?: TaskStatus; brandId?: string; sectionId?: string } = {},
  ) {
    const { page = 1, limit = 25, q, status, brandId, sectionId: filterSectionId } = filters;
    const skip = (page - 1) * limit;
    const where = await this.taskWhere(roles, accountId, sectionId, { q, status, brandId, sectionId: filterSectionId });

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: TASK_LIST_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.task.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async dashboardSummary(roles: AccountRole[], accountId: string, sectionId: string | null) {
    const where = await this.taskWhere(roles, accountId, sectionId);
    const last24Hours = new Date(Date.now() - 24 * 60 * 60_000);
    const isBpoOnly = roles.includes(AccountRole.bpo)
      && !roles.includes(AccountRole.admin)
      && !roles.includes(AccountRole.super_admin)
      && !roles.includes(AccountRole.user);
    const [grouped, total, createdLast24Hours, scopedBrandRows] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.task.count({ where }),
      this.prisma.task.count({ where: { AND: [where, { createdAt: { gte: last24Hours } }] } }),
      isBpoOnly
        ? this.prisma.task.findMany({
          where: { AND: [where, { brandId: { not: null } }] },
          distinct: ['brandId'],
          select: { brandId: true },
        })
        : Promise.resolve([]),
    ]);
    const scopedBrandIds = scopedBrandRows.flatMap(row => row.brandId ? [row.brandId] : []);
    const scopedShopCount = isBpoOnly && scopedBrandIds.length
      ? await this.prisma.shop.count({ where: { brandId: { in: scopedBrandIds } } })
      : 0;
    const counts = Object.fromEntries(
      Object.values(TaskStatus).map(status => [status, 0]),
    ) as Record<TaskStatus, number>;
    for (const row of grouped) counts[row.status] = row._count._all;
    const active = counts.scheduled + counts.pending + counts.assigned + counts.in_progress + counts.blocked;
    const attention = counts.blocked + counts.failed;
    const resolved = counts.done + counts.failed;
    return {
      total,
      counts,
      active,
      attention,
      createdLast24Hours,
      completionRate: resolved ? Math.round((counts.done / resolved) * 100) : 0,
      scopedBrandCount: isBpoOnly ? scopedBrandIds.length : undefined,
      scopedShopCount: isBpoOnly ? scopedShopCount : undefined,
    };
  }

  async filterOptions(roles: AccountRole[], accountId: string, sectionId: string | null) {
    const allowedSectionIds = await this.sectionAccess.accessibleSectionIds({ id: accountId, roles, sectionId });
    const sections = await this.prisma.section.findMany({
      where: allowedSectionIds === null ? undefined : { id: { in: allowedSectionIds } },
      select: { id: true, name: true, order: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
    return { sections };
  }

  private async taskWhere(
    roles: AccountRole[],
    accountId: string,
    sectionId: string | null,
    filters: { q?: string; status?: TaskStatus; brandId?: string; sectionId?: string } = {},
  ): Promise<Prisma.TaskWhereInput> {
    const AND: Prisma.TaskWhereInput[] = [{ deletedAt: null }];
    const allowedSectionIds = await this.sectionAccess.accessibleSectionIds({ id: accountId, roles, sectionId });
    if (allowedSectionIds !== null) AND.push({ taskType: { sectionId: { in: allowedSectionIds } } });

    const isSuperAdmin = roles.includes(AccountRole.super_admin);
    const isAdmin = roles.includes(AccountRole.admin);
    const isBpo = roles.includes(AccountRole.bpo);
    const isUser = roles.includes(AccountRole.user);
    if (!isSuperAdmin && !isAdmin) {
      if (isUser && !isBpo) {
        AND.push({ createdById: accountId });
      } else if (isBpo && !isUser) {
        AND.push({ stepInstances: { some: { assignedToId: accountId } } });
      }
    }

    if (filters.status) AND.push({ status: filters.status });
    if (filters.brandId) AND.push({ brandId: filters.brandId });
    if (filters.sectionId) AND.push({ taskType: { sectionId: filters.sectionId } });
    if (filters.q) AND.push({
      OR: [
        { brand: { brandName: { contains: filters.q, mode: 'insensitive' } } },
        { taskType: { name: { contains: filters.q, mode: 'insensitive' } } },
      ],
    });
    return { AND };
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
      }
      const taskSectionId = (task as { taskType?: { sectionId?: string } }).taskType?.sectionId;
      if (taskSectionId && !(await this.sectionAccess.canAccess({ id: accountId, roles, sectionId }, taskSectionId))) {
        throw new ForbiddenException('Task not found');
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
      : /^(?:shops|store-menu|brand-menu|store-promotions|brand-promotions)-[a-zA-Z0-9_-]+\.xlsx$/;
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
    this.assertAdminAssignment(requester);
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

  async bulkReassign(taskIds: string[], accountId: string, requester: JwtUser) {
    this.assertAdminAssignment(requester);
    const uniqueTaskIds = [...new Set(taskIds)];
    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);
    const target = await this.prisma.account.findFirst({
      where: {
        id: accountId,
        deletedAt: null,
        roles: { has: AccountRole.bpo },
        ...(!isSuperAdmin ? { sectionId: requester.sectionId ?? undefined } : {}),
      },
      select: { id: true, name: true, email: true },
    });
    if (!target) {
      throw new BadRequestException('Selected account is not an available BPO in your section');
    }

    const accessibleWhere = await this.taskWhere(
      requester.roles,
      requester.id,
      requester.sectionId,
    );
    const tasks = await this.prisma.task.findMany({
      where: { AND: [accessibleWhere, { id: { in: uniqueTaskIds } }] },
      select: {
        id: true,
        stepInstances: {
          where: {
            status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] },
            stepDefinition: { executionType: { not: ExecutionType.automatic } },
          },
          select: {
            id: true,
            assignedToId: true,
            stepDefinition: { select: { order: true, name: true } },
          },
          orderBy: { stepDefinition: { order: 'asc' } },
        },
      },
    });
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const results: Array<{
      taskId: string;
      status: 'reassigned' | 'unchanged' | 'skipped' | 'failed';
      stepsReassigned: number;
      message?: string;
    }> = [];

    for (const taskId of uniqueTaskIds) {
      const task = taskById.get(taskId);
      if (!task) {
        results.push({ taskId, status: 'skipped', stepsReassigned: 0, message: 'Task is unavailable or outside your section' });
        continue;
      }
      if (!task.stepInstances.length) {
        results.push({ taskId, status: 'skipped', stepsReassigned: 0, message: 'No active human step can be reassigned' });
        continue;
      }

      const currentOrder = task.stepInstances[0].stepDefinition.order;
      const activeSteps = task.stepInstances.filter(step => step.stepDefinition.order === currentOrder);
      const stepsToMove = activeSteps.filter(step => step.assignedToId !== accountId);
      if (!stepsToMove.length) {
        results.push({ taskId, status: 'unchanged', stepsReassigned: 0, message: 'The selected BPO already owns the active step' });
        continue;
      }

      let stepsReassigned = 0;
      try {
        for (const step of stepsToMove) {
          await this.engine.assignOrReassignStep(step.id, accountId);
          stepsReassigned++;
        }
        results.push({ taskId, status: 'reassigned', stepsReassigned });
      } catch (error) {
        results.push({
          taskId,
          status: 'failed',
          stepsReassigned,
          message: error instanceof Error ? error.message : 'Unexpected reassignment error',
        });
      }
    }

    return {
      requested: uniqueTaskIds.length,
      reassigned: results.filter(result => result.status === 'reassigned').length,
      unchanged: results.filter(result => result.status === 'unchanged').length,
      skipped: results.filter(result => result.status === 'skipped').length,
      failed: results.filter(result => result.status === 'failed').length,
      target,
      results,
    };
  }

  async assignableBpos(requester: JwtUser) {
    this.assertAdminAssignment(requester);
    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);

    if (!isSuperAdmin && !requester.sectionId) {
      return { data: [] };
    }

    const data = await this.prisma.account.findMany({
      where: {
        deletedAt: null,
        roles: { has: AccountRole.bpo },
        ...(isSuperAdmin ? {} : { sectionId: requester.sectionId! }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        roles: true,
        sectionId: true,
        adminModules: true,
        bpoPermissions: true,
      },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });

    return { data };
  }

  private assertAdminAssignment(requester: JwtUser) {
    if (!requester.roles.some(role => role === AccountRole.admin || role === AccountRole.super_admin)) {
      throw new ForbiddenException('Only admins can assign or reassign BPOs');
    }
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
