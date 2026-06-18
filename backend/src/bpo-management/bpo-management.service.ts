import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, Prisma, StepStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BpoManagementService {
  constructor(private prisma: PrismaService) {}

  // ── Active tasks for authenticated BPO ───────────────────────────────────

  myActiveTasks(accountId: string) {
    // Show steps assigned to this BPO regardless of whether they clicked Start
    const activeStepWhere = {
      assignedToId: accountId,
      status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] as StepStatus[] },
    };

    return this.prisma.task.findMany({
      where: {
        deletedAt: null,
        status: { notIn: [TaskStatus.done, TaskStatus.failed, TaskStatus.scheduled] },
        stepInstances: { some: activeStepWhere },
      },
      include: {
        taskType: { select: { id: true, name: true } },
        brand: { select: { id: true, brandName: true, country: true } },
        stepInstances: {
          where: activeStepWhere,
          include: { stepDefinition: { select: { name: true, order: true, executionType: true } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ── Performance of authenticated BPO ─────────────────────────────────────

  async myPerformance(accountId: string) {
    return this.buildPerformance(accountId);
  }

  // ── Admin view: performance of entire team ────────────────────────────────

  async teamPerformance(
    roles: AccountRole[],
    sectionId: string | null,
    filters: { taskTypeId?: string; year?: number; month?: number; week?: number } = {},
  ) {
    const where = roles.includes(AccountRole.super_admin)
      ? { roles: { has: AccountRole.bpo } }
      : { sectionId: sectionId ?? undefined, roles: { has: AccountRole.bpo } };

    const bpos = await this.prisma.account.findMany({
      where: { ...where, deletedAt: null },
      select: { id: true, name: true, email: true, workload: true, rrCounter: true },
      orderBy: { name: 'asc' },
    });

    const performances = await Promise.all(
      bpos.map(async (bpo) => ({
        account: bpo,
        ...(await this.buildPerformance(bpo.id, filters)),
      })),
    );

    return performances;
  }

  // ── Performance of a specific BPO (admin) ─────────────────────────────────

  async bpoPerformance(accountId: string, filters: { taskTypeId?: string; year?: number; month?: number; week?: number } = {}) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, email: true, workload: true, rrCounter: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return { account, ...(await this.buildPerformance(accountId, filters)) };
  }

  // ── Available filter options (years / months / weeks with real data) ─────

  async filterOptions(roles: AccountRole[], sectionId: string | null, year?: number) {
    const sectionFilter = roles.includes(AccountRole.super_admin) ? '' : `AND t.section_id = '${sectionId}'`;

    if (!year) {
      const rows = await this.prisma.$queryRaw<{ y: number }[]>`
        SELECT DISTINCT y FROM (
          SELECT EXTRACT(YEAR FROM t.created_at)::int AS y
          FROM task t
          JOIN task_type tt ON tt.id = t.task_type_id
          WHERE t.deleted_at IS NULL ${Prisma.raw(sectionFilter)}
          UNION
          SELECT EXTRACT(YEAR FROM ta.task_created_at)::int AS y
          FROM task_archive ta
          WHERE TRUE ${Prisma.raw(sectionFilter.replace('t.section_id', 'ta.section_id'))}
        ) sub
        ORDER BY y DESC
      `;
      return { years: rows.map(r => r.y), months: [], weeks: [] };
    }

    const [monthRows, weekRows] = await Promise.all([
      this.prisma.$queryRaw<{ m: number }[]>`
        SELECT DISTINCT m FROM (
          SELECT EXTRACT(MONTH FROM t.created_at)::int AS m
          FROM task t
          JOIN task_type tt ON tt.id = t.task_type_id
          WHERE t.deleted_at IS NULL AND EXTRACT(YEAR FROM t.created_at) = ${year}
          ${Prisma.raw(sectionFilter)}
          UNION
          SELECT EXTRACT(MONTH FROM ta.task_created_at)::int AS m
          FROM task_archive ta
          WHERE EXTRACT(YEAR FROM ta.task_created_at) = ${year}
          ${Prisma.raw(sectionFilter.replace('t.section_id', 'ta.section_id'))}
        ) sub ORDER BY m
      `,
      this.prisma.$queryRaw<{ w: number }[]>`
        SELECT DISTINCT w FROM (
          SELECT EXTRACT(WEEK FROM t.created_at)::int AS w
          FROM task t
          JOIN task_type tt ON tt.id = t.task_type_id
          WHERE t.deleted_at IS NULL AND EXTRACT(YEAR FROM t.created_at) = ${year}
          ${Prisma.raw(sectionFilter)}
          UNION
          SELECT EXTRACT(WEEK FROM ta.task_created_at)::int AS w
          FROM task_archive ta
          WHERE EXTRACT(YEAR FROM ta.task_created_at) = ${year}
          ${Prisma.raw(sectionFilter.replace('t.section_id', 'ta.section_id'))}
        ) sub ORDER BY w
      `,
    ]);

    return { years: [], months: monthRows.map(r => r.m), weeks: weekRows.map(r => r.w) };
  }

  // ── Team history (from task_archive) ─────────────────────────────────────

  async teamHistory(
    roles: AccountRole[],
    sectionId: string | null,
    filters: { page?: number; limit?: number; taskTypeId?: string; year?: number; month?: number; week?: number } = {},
  ) {
    const { page = 1, limit = 25, taskTypeId, year, month, week } = filters;
    const skip = (page - 1) * limit;

    const AND: any[] = [];

    if (!roles.includes(AccountRole.super_admin)) {
      AND.push({ sectionId: sectionId ?? undefined });
    }
    if (taskTypeId) AND.push({ taskTypeId });

    if (year || month || week) {
      if (week && year) {
        // ISO week: find Monday of that week
        const jan4 = new Date(year, 0, 4);
        const startOfWeek1 = new Date(jan4);
        startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
        const weekStart = new Date(startOfWeek1);
        weekStart.setDate(startOfWeek1.getDate() + (week - 1) * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);
        AND.push({ taskCreatedAt: { gte: weekStart, lt: weekEnd } });
      } else if (month && year) {
        const start = new Date(year, month - 1, 1);
        const end   = new Date(year, month, 1);
        AND.push({ taskCreatedAt: { gte: start, lt: end } });
      } else if (year) {
        const start = new Date(year, 0, 1);
        const end   = new Date(year + 1, 0, 1);
        AND.push({ taskCreatedAt: { gte: start, lt: end } });
      }
    }

    const where = AND.length > 0 ? { AND } : {};

    const [data, total] = await Promise.all([
      this.prisma.taskArchive.findMany({ where, orderBy: { taskCreatedAt: 'desc' }, skip, take: limit }),
      this.prisma.taskArchive.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  // ── Internal helper ───────────────────────────────────────────────────────

  private buildDateRange(year?: number, month?: number, week?: number): { gte: Date; lt: Date } | null {
    if (!year) return null;
    if (week) {
      const jan4 = new Date(year, 0, 4);
      const startOfWeek1 = new Date(jan4);
      startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
      const start = new Date(startOfWeek1);
      start.setDate(startOfWeek1.getDate() + (week - 1) * 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return { gte: start, lt: end };
    }
    if (month) {
      return { gte: new Date(year, month - 1, 1), lt: new Date(year, month, 1) };
    }
    return { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) };
  }

  private async buildPerformance(
    accountId: string,
    filters: { taskTypeId?: string; year?: number; month?: number; week?: number } = {},
  ) {
    const { taskTypeId, year, month, week } = filters;
    const dateRange = this.buildDateRange(year, month, week);

    const taskFilter: Prisma.TaskWhereInput = {
      ...(dateRange  ? { createdAt: dateRange } : {}),
      ...(taskTypeId ? { taskTypeId }           : {}),
    };
    const hasTaskFilter = dateRange || taskTypeId;

    const stepWhere = (status: StepStatus | { in: StepStatus[] }): Prisma.StepInstanceWhereInput => ({
      assignedToId: accountId,
      status,
      ...(hasTaskFilter ? { task: taskFilter } : {}),
    });

    const activeWhere: Prisma.StepInstanceWhereInput = {
      assignedToId: accountId,
      status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] },
      ...(hasTaskFilter ? { task: taskFilter } : {}),
    };

    const [totalCompleted, totalFailed, totalInProgress] = await Promise.all([
      this.prisma.stepInstance.count({ where: stepWhere(StepStatus.done) }),
      this.prisma.stepInstance.count({ where: stepWhere(StepStatus.failed) }),
      this.prisma.stepInstance.count({ where: activeWhere }),
    ]);

    // Average active work time — filter through task to match ORM queries above
    const dateFilter = dateRange
      ? Prisma.sql`AND task_id IN (SELECT id FROM task WHERE created_at >= ${dateRange.gte} AND created_at < ${dateRange.lt})`
      : Prisma.empty;
    const typeFilter = taskTypeId
      ? Prisma.sql`AND task_id IN (SELECT id FROM task WHERE task_type_id = ${taskTypeId}::uuid)`
      : Prisma.empty;

    const avgResult = await this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT AVG(worked_seconds) / 3600.0 AS avg_hours
      FROM step_instance
      WHERE asignado_id = ${accountId}::uuid
        AND estado = 'done'
        AND worked_seconds IS NOT NULL
        ${dateFilter}
        ${typeFilter}
    `;

    return {
      stepsCompleted: totalCompleted,
      stepsFailed: totalFailed,
      stepsInProgress: totalInProgress,
      avgCompletionHours: avgResult[0]?.avg_hours ?? null,
    };
  }
}
