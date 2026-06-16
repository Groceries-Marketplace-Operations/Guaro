import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ExecutionType, StepFailureReason, StepStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from '../tasks/task-engine.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';

const AUTO_STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private engine: TaskEngineService,
    private webhookSender: WebhookSenderService,
  ) {}

  // Activate scheduled tasks whose window has opened
  @Cron('*/5 * * * *')
  async activateScheduledTasks() {
    const tasks = await this.prisma.task.findMany({
      where: { status: TaskStatus.scheduled, scheduledStart: { lte: new Date() } },
      include: { taskType: { include: { stepDefinitions: { orderBy: { order: 'asc' }, take: 1 } } } },
    });

    for (const task of tasks) {
      try {
        await this.prisma.task.update({ where: { id: task.id }, data: { status: TaskStatus.pending } });

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
      } catch (err) {
        this.logger.error(`Error activating task ${task.id}: ${(err as Error).message}`);
      }
    }
  }

  // Expired manual steps: window closed and not yet completed
  @Cron('*/5 * * * *')
  async checkBpoTimeouts() {
    const now = new Date();

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        status: { in: [StepStatus.in_progress, StepStatus.blocked] },
        stepDefinition: { executionType: { in: [ExecutionType.manual_external, ExecutionType.manual_internal] } },
        task: { scheduledEnd: { lte: now }, status: TaskStatus.in_progress },
      },
      include: { stepDefinition: true, task: true },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepFailureReason.bpo_timed_out);
        await this.webhookSender.sendAlert({
          text: `⏰ BPO timeout on task ${step.taskId} step ${step.stepDefinitionId}`,
          attachments: [{ title: 'BPO Timeout', text: `Step: ${step.stepDefinition.name}`, color: '#FF9800' }],
        });
      } catch (err) {
        this.logger.error(`Error on bpo timeout ${step.id}: ${(err as Error).message}`);
      }
    }
  }

  // Automatic steps running for more than 2h
  @Cron('*/10 * * * *')
  async checkAutoTimeouts() {
    const cutoff = new Date(Date.now() - AUTO_STEP_TIMEOUT_MS);

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        status: StepStatus.in_progress,
        stepDefinition: { executionType: ExecutionType.automatic },
        updatedAt: { lte: cutoff },
      },
      include: { stepDefinition: true },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepFailureReason.system_timed_out);
        await this.webhookSender.sendAlert({
          text: `🚨 System timeout on automatic step ${step.id}`,
          attachments: [{ title: 'System Timeout', text: `Handler: ${step.stepDefinition.handlerId}`, color: '#F44336' }],
        });
      } catch (err) {
        this.logger.error(`Error on system timeout ${step.id}: ${(err as Error).message}`);
      }
    }
  }
}
