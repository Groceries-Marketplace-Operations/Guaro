import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StepEstado, StepMotivoFallo, TaskEstado, TipoEjecucion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from '../tasks/task-engine.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';

const AUTO_STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private engine: TaskEngineService,
    private webhookSender: WebhookSenderService,
  ) {}

  // Activa tareas programadas cuya ventana ya abrió
  @Cron('*/5 * * * *')
  async activateScheduledTasks() {
    const tasks = await this.prisma.task.findMany({
      where: { estado: TaskEstado.scheduled, programadoInicio: { lte: new Date() } },
      include: { taskType: { include: { stepDefinitions: { orderBy: { orden: 'asc' }, take: 1 } } } },
    });

    for (const task of tasks) {
      try {
        await this.prisma.task.update({ where: { id: task.id }, data: { estado: TaskEstado.pending } });

        const firstStep = await this.prisma.stepInstance.findFirst({
          where: { taskId: task.id },
          include: { stepDefinition: true },
          orderBy: { stepDefinition: { orden: 'asc' } },
        });

        if (firstStep) {
          await this.engine.activateStep(firstStep.id);
          if (firstStep.stepDefinition.tipoEjecucion === TipoEjecucion.automatico) {
            this.engine.emitAutoStep(firstStep.id, firstStep.stepDefinition.handlerId!);
          }
        }
      } catch (err) {
        this.logger.error(`Error activando tarea ${task.id}: ${(err as Error).message}`);
      }
    }
  }

  // Steps manuales vencidos: ventana cerrada y sin completar
  @Cron('*/5 * * * *')
  async checkBpoTimeouts() {
    const now = new Date();

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        estado: { in: [StepEstado.in_progress, StepEstado.blocked] },
        stepDefinition: { tipoEjecucion: { in: [TipoEjecucion.manual_externo, TipoEjecucion.manual_interno] } },
        task: { programadoFin: { lte: now }, estado: TaskEstado.in_progress },
      },
      include: { stepDefinition: true, task: true },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepMotivoFallo.bpo_timed_out);
        await this.webhookSender.sendAlert({
          text: `⏰ BPO timeout en task ${step.taskId} step ${step.stepDefinitionId}`,
          attachments: [{ title: 'BPO Timeout', text: `Step: ${step.stepDefinition.nombre}`, color: '#FF9800' }],
        });
      } catch (err) {
        this.logger.error(`Error en bpo timeout ${step.id}: ${(err as Error).message}`);
      }
    }
  }

  // Steps automáticos en ejecución hace más de 2h
  @Cron('*/10 * * * *')
  async checkAutoTimeouts() {
    const cutoff = new Date(Date.now() - AUTO_STEP_TIMEOUT_MS);

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        estado: StepEstado.in_progress,
        stepDefinition: { tipoEjecucion: TipoEjecucion.automatico },
        updatedAt: { lte: cutoff },
      },
      include: { stepDefinition: true },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepMotivoFallo.system_timed_out);
        await this.webhookSender.sendAlert({
          text: `🚨 System timeout en step automático ${step.id}`,
          attachments: [{ title: 'System Timeout', text: `Handler: ${step.stepDefinition.handlerId}`, color: '#F44336' }],
        });
      } catch (err) {
        this.logger.error(`Error en system timeout ${step.id}: ${(err as Error).message}`);
      }
    }
  }
}
