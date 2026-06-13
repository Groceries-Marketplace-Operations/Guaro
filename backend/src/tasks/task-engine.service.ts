import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EstrategiaAsignacion,
  Prisma,
  StepEstado,
  StepMotivoFallo,
  TaskEstado,
  TipoEjecucion,
  WebhookEvento,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class TaskEngineService {
  private readonly logger = new Logger(TaskEngineService.name);

  constructor(
    private prisma: PrismaService,
    private webhookSender: WebhookSenderService,
  ) {}

  // ── Activar un step (just-in-time assignment) ─────────────────────────────

  async activateStep(stepInstanceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const step = await tx.stepInstance.findUnique({
        where: { id: stepInstanceId },
        include: { stepDefinition: { include: { candidatos: true } }, task: true },
      });
      if (!step) throw new NotFoundException('StepInstance no encontrado');
      if (step.estado !== StepEstado.pending) return;

      const asignadoId = await this.assignBpo(tx, step.stepDefinition);

      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: { estado: StepEstado.in_progress, asignadoId },
      });

      await tx.task.update({
        where: { id: step.taskId },
        data: { estado: TaskEstado.in_progress },
      });
    });

    // Webhook fuera de la tx (best-effort)
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (step) {
      await this.sendStepWebhook(step.stepDefinitionId, WebhookEvento.al_iniciar, step.taskId);
    }
  }

  // ── Completar un step ─────────────────────────────────────────────────────

  async completeStep(stepInstanceId: string, resultado?: unknown, nota?: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({
      where: { id: stepInstanceId },
      include: { stepDefinition: true },
    });
    if (!step) throw new NotFoundException('StepInstance no encontrado');
    if (step.estado !== StepEstado.in_progress) {
      throw new BadRequestException('Solo se puede completar un step en in_progress');
    }

    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: {
        estado: StepEstado.done,
        completadoEn: new Date(),
        resultado: resultado as Prisma.InputJsonValue ?? Prisma.JsonNull,
        nota: nota ?? null,
      },
    });

    await this.sendStepWebhook(step.stepDefinitionId, WebhookEvento.al_terminar, step.taskId);
    await this.advanceTask(step.taskId);
  }

  // ── Fallar un step ────────────────────────────────────────────────────────

  async failStep(
    stepInstanceId: string,
    motivoFallo: StepMotivoFallo,
    nota?: string,
  ): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (!step) throw new NotFoundException('StepInstance no encontrado');

    await this.prisma.$transaction([
      this.prisma.stepInstance.update({
        where: { id: stepInstanceId },
        data: { estado: StepEstado.failed, motivoFallo, nota: nota ?? null, completadoEn: new Date() },
      }),
      this.prisma.task.update({
        where: { id: step.taskId },
        data: { estado: TaskEstado.failed },
      }),
    ]);

    await this.sendStepWebhook(step.stepDefinitionId, WebhookEvento.al_fallar, step.taskId);
  }

  // ── Bloquear un step (solo manual) ───────────────────────────────────────

  async blockStep(stepInstanceId: string, nota?: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({
      where: { id: stepInstanceId },
      include: { stepDefinition: true },
    });
    if (!step) throw new NotFoundException('StepInstance no encontrado');
    if (step.stepDefinition.tipoEjecucion === TipoEjecucion.automatico) {
      throw new BadRequestException('Los steps automáticos no pueden bloquearse');
    }
    if (step.estado !== StepEstado.in_progress) {
      throw new BadRequestException('Solo se puede bloquear un step en in_progress');
    }

    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: { estado: StepEstado.blocked, nota: nota ?? null },
    });
  }

  // ── Reintentar un step bloqueado ──────────────────────────────────────────

  async retryStep(stepInstanceId: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (!step) throw new NotFoundException('StepInstance no encontrado');
    if (step.estado !== StepEstado.blocked) {
      throw new BadRequestException('Solo se puede reintentar un step bloqueado');
    }
    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: { estado: StepEstado.in_progress, nota: null },
    });
  }

  // ── Avanzar la tarea al siguiente step ────────────────────────────────────

  async advanceTask(taskId: string): Promise<void> {
    const nextStep = await this.prisma.stepInstance.findFirst({
      where: { taskId, estado: StepEstado.pending },
      include: { stepDefinition: true },
      orderBy: { stepDefinition: { orden: 'asc' } },
    });

    if (!nextStep) {
      await this.prisma.task.update({ where: { id: taskId }, data: { estado: TaskEstado.done } });
      return;
    }

    await this.activateStep(nextStep.id);

    // Si es automático, publicar en cola (el módulo queue se encarga)
    if (nextStep.stepDefinition.tipoEjecucion === TipoEjecucion.automatico) {
      this.emitAutoStep(nextStep.id, nextStep.stepDefinition.handlerId!);
    }
  }

  // Lo sobreescribe QueueModule para publicar el job (evita circular dep)
  emitAutoStep: (stepInstanceId: string, handlerId: string) => void = () => undefined;

  // ── Asignación just-in-time ───────────────────────────────────────────────

  private async assignBpo(tx: Tx, stepDef: { id: string; estrategiaAsignacion: EstrategiaAsignacion; peso: number }): Promise<string | undefined> {
    const candidatos = await tx.stepDefinitionAccount.findMany({
      where: { stepDefinitionId: stepDef.id },
    });
    if (!candidatos.length) return undefined;

    if (stepDef.estrategiaAsignacion === EstrategiaAsignacion.fijo) {
      return candidatos[0].accountId;
    }

    if (stepDef.estrategiaAsignacion === EstrategiaAsignacion.round_robin) {
      const rows = await tx.$queryRaw<{ id: string; contador_rr: number }[]>`
        SELECT a.id, a.contador_rr
        FROM step_definition_account sda
        JOIN account a ON a.id = sda.account_id
        WHERE sda.step_definition_id = ${stepDef.id}::uuid
        ORDER BY a.contador_rr ASC
        LIMIT 1
        FOR UPDATE OF a
      `;
      if (!rows.length) return undefined;
      await tx.account.update({ where: { id: rows[0].id }, data: { contadorRr: { increment: 1 } } });
      return rows[0].id;
    }

    // por_peso: menor carga, incrementar por el peso del step
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
      FROM step_definition_account sda
      JOIN account a ON a.id = sda.account_id
      WHERE sda.step_definition_id = ${stepDef.id}::uuid
      ORDER BY a.carga ASC
      LIMIT 1
      FOR UPDATE OF a
    `;
    if (!rows.length) return undefined;
    await tx.account.update({ where: { id: rows[0].id }, data: { carga: { increment: stepDef.peso } } });
    return rows[0].id;
  }

  // ── Webhook helper ────────────────────────────────────────────────────────

  private async sendStepWebhook(stepDefinitionId: string, evento: WebhookEvento, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { brand: true, taskType: true },
    });

    const colorMap: Record<WebhookEvento, string> = {
      al_iniciar: '#2196F3',
      al_terminar: '#4CAF50',
      al_fallar: '#F44336',
    };

    const payload = {
      text: `[${task?.taskType.nombre ?? 'Tarea'}] ${evento.replace('al_', '')} — ${task?.brand?.brandName ?? ''}`,
      attachments: [{
        title: task?.taskType.nombre ?? '',
        text: task?.brand ? `Marca: ${task.brand.brandName} (${task.brand.country})` : '',
        color: colorMap[evento],
      }],
    };

    await this.webhookSender.sendForStep(stepDefinitionId, evento, payload).catch((err) =>
      this.logger.error(`Webhook error: ${err.message}`),
    );
  }
}
