import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountRol, StepEstado, TaskEstado } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BpoManagementService {
  constructor(private prisma: PrismaService) {}

  // ── Tareas activas del BPO autenticado ────────────────────────────────────

  myActiveTasks(accountId: string) {
    return this.prisma.task.findMany({
      where: {
        deletedAt: null,
        estado: { in: [TaskEstado.in_progress, TaskEstado.assigned] },
        stepInstances: {
          some: {
            asignadoId: accountId,
            estado: { in: [StepEstado.in_progress, StepEstado.blocked] },
          },
        },
      },
      include: {
        taskType: { select: { id: true, nombre: true } },
        brand: { select: { id: true, brandName: true, country: true } },
        stepInstances: {
          where: { asignadoId: accountId, estado: { in: [StepEstado.in_progress, StepEstado.blocked] } },
          include: { stepDefinition: { select: { nombre: true, orden: true, tipoEjecucion: true } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ── Performance del BPO autenticado ──────────────────────────────────────

  async myPerformance(accountId: string) {
    return this.buildPerformance(accountId);
  }

  // ── Vista admin: performance de todo el team ──────────────────────────────

  async teamPerformance(roles: AccountRol[], sectionId: string | null) {
    const where = roles.includes(AccountRol.super_admin)
      ? {}
      : { sectionId: sectionId ?? undefined, roles: { has: AccountRol.bpo } };

    const bpos = await this.prisma.account.findMany({
      where: { ...where, deletedAt: null },
      select: { id: true, nombre: true, email: true, carga: true, contadorRr: true },
      orderBy: { nombre: 'asc' },
    });

    const performances = await Promise.all(
      bpos.map(async (bpo) => ({
        account: bpo,
        ...(await this.buildPerformance(bpo.id)),
      })),
    );

    return performances;
  }

  // ── Performance de un BPO específico (admin) ──────────────────────────────

  async bpoPerformance(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, nombre: true, email: true, carga: true, contadorRr: true },
    });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    return { account, ...(await this.buildPerformance(accountId)) };
  }

  // ── Histórico del team ────────────────────────────────────────────────────

  teamHistory(roles: AccountRol[], sectionId: string | null) {
    const where = roles.includes(AccountRol.super_admin)
      ? { deletedAt: null }
      : { deletedAt: null, taskType: { sectionId: sectionId ?? undefined } };

    return this.prisma.task.findMany({
      where,
      include: {
        taskType: { select: { id: true, nombre: true } },
        brand: { select: { id: true, brandName: true, country: true } },
        createdBy: { select: { id: true, nombre: true } },
        stepInstances: {
          include: {
            stepDefinition: { select: { nombre: true, orden: true } },
            asignado: { select: { id: true, nombre: true } },
          },
          orderBy: { stepDefinition: { orden: 'asc' } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ── Helper interno ────────────────────────────────────────────────────────

  private async buildPerformance(accountId: string) {
    const [totalCompleted, totalFailed, totalInProgress] = await Promise.all([
      this.prisma.stepInstance.count({
        where: { asignadoId: accountId, estado: StepEstado.done },
      }),
      this.prisma.stepInstance.count({
        where: { asignadoId: accountId, estado: StepEstado.failed },
      }),
      this.prisma.stepInstance.count({
        where: { asignadoId: accountId, estado: { in: [StepEstado.in_progress, StepEstado.blocked] } },
      }),
    ]);

    // Tiempo promedio de completado en horas
    const avgResult = await this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM AVG(completado_en - created_at)) / 3600 AS avg_hours
      FROM step_instance
      WHERE asignado_id = ${accountId}::uuid AND estado = 'done'
    `;

    return {
      stepsCompletados: totalCompleted,
      stepsFallidos: totalFailed,
      stepsEnCurso: totalInProgress,
      promedioHorasCompletado: avgResult[0]?.avg_hours ?? null,
    };
  }
}
