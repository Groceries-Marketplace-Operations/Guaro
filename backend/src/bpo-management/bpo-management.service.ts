import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, StepStatus, TaskStatus } from '@prisma/client';
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

  async teamPerformance(roles: AccountRole[], sectionId: string | null) {
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
        ...(await this.buildPerformance(bpo.id)),
      })),
    );

    return performances;
  }

  // ── Performance of a specific BPO (admin) ─────────────────────────────────

  async bpoPerformance(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, email: true, workload: true, rrCounter: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return { account, ...(await this.buildPerformance(accountId)) };
  }

  // ── Team history ──────────────────────────────────────────────────────────

  async teamHistory(
    roles: AccountRole[],
    sectionId: string | null,
    { page = 1, limit = 25 }: { page?: number; limit?: number } = {},
  ) {
    const skip = (page - 1) * limit;
    const where = roles.includes(AccountRole.super_admin)
      ? { deletedAt: null }
      : { deletedAt: null, taskType: { sectionId: sectionId ?? undefined } };

    const include = {
      taskType: { select: { id: true, name: true } },
      brand: { select: { id: true, brandName: true, country: true } },
      createdBy: { select: { id: true, name: true } },
      stepInstances: {
        include: {
          stepDefinition: { select: { name: true, order: true } },
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: { stepDefinition: { order: 'asc' as const } },
      },
    } as const;

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.task.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  // ── Internal helper ───────────────────────────────────────────────────────

  private async buildPerformance(accountId: string) {
    const [totalCompleted, totalFailed, totalInProgress] = await Promise.all([
      this.prisma.stepInstance.count({
        where: { assignedToId: accountId, status: StepStatus.done },
      }),
      this.prisma.stepInstance.count({
        where: { assignedToId: accountId, status: StepStatus.failed },
      }),
      this.prisma.stepInstance.count({
        where: { assignedToId: accountId, status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] } },
      }),
    ]);

    // Average active work time (excludes blocked periods)
    const avgResult = await this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT AVG(worked_seconds) / 3600.0 AS avg_hours
      FROM step_instance
      WHERE asignado_id = ${accountId}::uuid AND estado = 'done' AND worked_seconds IS NOT NULL
    `;

    return {
      stepsCompleted: totalCompleted,
      stepsFailed: totalFailed,
      stepsInProgress: totalInProgress,
      avgCompletionHours: avgResult[0]?.avg_hours ?? null,
    };
  }
}
