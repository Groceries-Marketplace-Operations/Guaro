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
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        status: { in: [StepStatus.in_progress, StepStatus.blocked] },
        stepDefinition: { executionType: { in: [ExecutionType.manual_external, ExecutionType.manual_internal] } },
        task: { scheduledEnd: { lte: now }, status: TaskStatus.in_progress },
      },
      include: {
        stepDefinition: true,
        assignedTo: { select: { email: true, name: true } },
        task: {
          include: {
            brand: true,
            taskType: true,
            createdBy: { select: { email: true, name: true } },
          },
        },
      },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepFailureReason.bpo_timed_out);
        const bpoHandle     = step.assignedTo?.email?.split('@')[0];
        const creatorHandle = step.task.createdBy?.email?.split('@')[0];
        const taskUrl       = `${frontendUrl}/tasks/${step.taskId}`;
        const lines = [
          `📋 Step: ${step.stepDefinition.name}`,
          step.task.brand ? `🏷️ ${step.task.brand.brandName} (${step.task.brand.country})` : null,
          bpoHandle     ? `👤 BPO: @${bpoHandle}`          : null,
          creatorHandle ? `✏️ Created by: @${creatorHandle}` : null,
          `🔗 ${taskUrl}`,
        ].filter(Boolean).join('\n');
        await this.webhookSender.sendAlert({
          text: `⏰ BPO timeout — **${step.task.taskType.name}**`,
          attachments: [{ title: 'BPO Timeout', text: lines, color: '#FF9800' }],
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
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';

    const steps = await this.prisma.stepInstance.findMany({
      where: {
        status: StepStatus.in_progress,
        stepDefinition: { executionType: ExecutionType.automatic },
        updatedAt: { lte: cutoff },
      },
      include: {
        stepDefinition: true,
        task: {
          include: {
            brand: true,
            taskType: true,
            createdBy: { select: { email: true, name: true } },
          },
        },
      },
    });

    for (const step of steps) {
      try {
        await this.engine.failStep(step.id, StepFailureReason.system_timed_out);
        const creatorHandle = step.task.createdBy?.email?.split('@')[0];
        const taskUrl       = `${frontendUrl}/tasks/${step.taskId}`;
        const lines = [
          `📋 Step: ${step.stepDefinition.name}`,
          `🔧 Handler: ${step.stepDefinition.handlerId ?? 'unknown'}`,
          step.task.brand ? `🏷️ ${step.task.brand.brandName} (${step.task.brand.country})` : null,
          creatorHandle ? `✏️ Created by: @${creatorHandle}` : null,
          `🔗 ${taskUrl}`,
        ].filter(Boolean).join('\n');
        await this.webhookSender.sendAlert({
          text: `🚨 System timeout — **${step.task.taskType.name}**`,
          attachments: [{ title: 'System Timeout', text: lines, color: '#F44336' }],
        });
      } catch (err) {
        this.logger.error(`Error on system timeout ${step.id}: ${(err as Error).message}`);
      }
    }
  }
}
