import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStrategy,
  ExecutionType,
  Prisma,
  StepFailureReason,
  StepStatus,
  TaskStatus,
  WebhookEvent,
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

  // ── Activate a step (just-in-time assignment) ─────────────────────────────
  // Manual steps: assign BPO + task→assigned (BPO must click "Start Review")
  // Automatic steps: assign + step→in_progress + task→in_progress immediately

  async activateStep(stepInstanceId: string): Promise<void> {
    let isAutomatic = false;

    await this.prisma.$transaction(async (tx) => {
      const step = await tx.stepInstance.findUnique({
        where: { id: stepInstanceId },
        include: { stepDefinition: { include: { candidates: true } }, task: true },
      });
      if (!step) throw new NotFoundException('StepInstance not found');
      if (step.status !== StepStatus.pending) return;

      const assignedToId = await this.assignBpo(tx, step.stepDefinition, step.taskId);
      isAutomatic = step.stepDefinition.executionType === ExecutionType.automatic;

      if (isAutomatic) {
        await tx.stepInstance.update({
          where: { id: stepInstanceId },
          data: { status: StepStatus.in_progress, assignedToId, startedAt: new Date() },
        });
        await tx.task.update({
          where: { id: step.taskId },
          data: { status: TaskStatus.in_progress },
        });
      } else {
        // Manual: assign BPO but keep step pending; task moves to assigned
        await tx.stepInstance.update({
          where: { id: stepInstanceId },
          data: { assignedToId },
        });
        await tx.task.update({
          where: { id: step.taskId },
          data: { status: TaskStatus.assigned },
        });
      }
    });

    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (step) {
      if (isAutomatic) {
        await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_start, step.taskId);
      } else {
        // Manual step: BPO just got assigned, fire on_assignment
        await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_assignment, step.taskId);
      }
    }
  }

  // ── BPO clicks "Start Review" ─────────────────────────────────────────────
  // Manual step: pending → in_progress, task assigned → in_progress

  async startStep(stepInstanceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const step = await tx.stepInstance.findUnique({
        where: { id: stepInstanceId },
        include: { stepDefinition: true },
      });
      if (!step) throw new NotFoundException('StepInstance not found');
      if (step.status !== StepStatus.pending) {
        throw new BadRequestException('Step must be pending to be started');
      }
      if (step.stepDefinition.executionType === ExecutionType.automatic) {
        throw new BadRequestException('Automatic steps cannot be manually started');
      }

      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: { status: StepStatus.in_progress, startedAt: new Date() },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.in_progress },
      });
    });

    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (step) {
      await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_start, step.taskId);
    }
  }

  // ── Complete a step ───────────────────────────────────────────────────────

  async completeStep(stepInstanceId: string, result?: unknown, note?: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({
      where: { id: stepInstanceId },
      include: { stepDefinition: true },
    });
    if (!step) throw new NotFoundException('StepInstance not found');
    if (step.status !== StepStatus.in_progress) {
      throw new BadRequestException('Step must be in_progress to be completed');
    }

    const now = new Date();
    const currentPeriod = step.startedAt
      ? Math.floor((now.getTime() - step.startedAt.getTime()) / 1000)
      : 0;

    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: {
        status: StepStatus.done,
        completedAt: now,
        result: result as Prisma.InputJsonValue ?? Prisma.JsonNull,
        note: note ?? null,
        workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
      },
    });

    await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_complete, step.taskId);
    await this.advanceTask(step.taskId);
  }

  // ── Fail a step ───────────────────────────────────────────────────────────

  async failStep(
    stepInstanceId: string,
    failureReason: StepFailureReason,
    note?: string,
  ): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (!step) throw new NotFoundException('StepInstance not found');

    const now = new Date();
    const currentPeriod = step.startedAt
      ? Math.floor((now.getTime() - step.startedAt.getTime()) / 1000)
      : 0;

    await this.prisma.$transaction([
      this.prisma.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.failed,
          failureReason,
          note: note ?? null,
          completedAt: now,
          workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
        },
      }),
      this.prisma.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.failed },
      }),
    ]);

    await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_fail, step.taskId);
  }

  // ── Block a step (manual only) ────────────────────────────────────────────

  async blockStep(stepInstanceId: string, note?: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({
      where: { id: stepInstanceId },
      include: { stepDefinition: true },
    });
    if (!step) throw new NotFoundException('StepInstance not found');
    if (step.stepDefinition.executionType === ExecutionType.automatic) {
      throw new BadRequestException('Automatic steps cannot be blocked');
    }
    if (step.status !== StepStatus.in_progress) {
      throw new BadRequestException('Step must be in_progress to be blocked');
    }

    const elapsedSeconds = step.startedAt
      ? Math.floor((Date.now() - step.startedAt.getTime()) / 1000)
      : 0;

    await this.prisma.$transaction([
      this.prisma.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.blocked,
          note: note ?? null,
          workedSeconds: (step.workedSeconds ?? 0) + elapsedSeconds,
          startedAt: null,
        },
      }),
      this.prisma.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.blocked },
      }),
    ]);

    await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_blocked, step.taskId);
  }

  // ── Retry a blocked step ──────────────────────────────────────────────────

  async retryStep(stepInstanceId: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (!step) throw new NotFoundException('StepInstance not found');
    if (step.status !== StepStatus.blocked) {
      throw new BadRequestException('Only blocked steps can be retried');
    }
    await this.prisma.$transaction([
      this.prisma.stepInstance.update({
        where: { id: stepInstanceId },
        data: { status: StepStatus.in_progress, note: null, startedAt: new Date() },
      }),
      this.prisma.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.in_progress },
      }),
    ]);
  }

  // ── Advance task to next step ─────────────────────────────────────────────

  async advanceTask(taskId: string): Promise<void> {
    const nextStep = await this.prisma.stepInstance.findFirst({
      where: { taskId, status: StepStatus.pending },
      include: { stepDefinition: true },
      orderBy: { stepDefinition: { order: 'asc' } },
    });

    if (!nextStep) {
      await this.prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.done } });
      return;
    }

    await this.activateStep(nextStep.id);

    // If automatic, publish to queue (queue module handles this)
    if (nextStep.stepDefinition.executionType === ExecutionType.automatic) {
      this.emitAutoStep(nextStep.id, nextStep.stepDefinition.handlerId!, taskId);
    }
  }

  // Overridden by QueueModule to publish the job (avoids circular dep)
  emitAutoStep: (stepInstanceId: string, handlerId: string, taskId: string) => void = () => undefined;

  // ── Manual step assignment (admin assigns BPO at runtime) ────────────────

  async assignStepManually(stepInstanceId: string, accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const step = await tx.stepInstance.findUnique({
        where: { id: stepInstanceId },
        include: { stepDefinition: true },
      });
      if (!step) throw new NotFoundException('StepInstance not found');
      if (step.stepDefinition.assignmentStrategy !== AssignmentStrategy.manual) {
        throw new BadRequestException('Step does not use manual assignment strategy');
      }
      if (step.status !== StepStatus.pending) {
        throw new BadRequestException('Step must be pending to be manually assigned');
      }

      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: { assignedToId: accountId },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.assigned },
      });
    });

    // Fire on_assignment webhook after manual assignment
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (step) {
      await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_assignment, step.taskId);
    }
  }

  // ── Just-in-time assignment ───────────────────────────────────────────────

  private async assignBpo(
    tx: Tx,
    stepDef: { id: string; assignmentStrategy: AssignmentStrategy; weight: number },
    taskId: string,
  ): Promise<string | undefined> {

    // ── Manual: admin assigns at runtime, no automatic assignment ────────────
    if (stepDef.assignmentStrategy === AssignmentStrategy.manual) {
      return undefined;
    }

    // ── Brand assignment: resolve BPO via BrandAssignmentRule ─────────────────
    if (stepDef.assignmentStrategy === AssignmentStrategy.brand_assignment) {
      return this.assignViaBrandRule(tx, taskId);
    }

    // ── Pool-based strategies ─────────────────────────────────────────────────
    const candidates = await tx.stepDefinitionAccount.findMany({
      where: { stepDefinitionId: stepDef.id },
    });
    if (!candidates.length) return undefined;

    if (stepDef.assignmentStrategy === AssignmentStrategy.fixed) {
      return candidates[0].accountId;
    }

    // round_robin (also fallback for by_weight)
    return this.roundRobinFromStep(tx, stepDef.id);
  }

  private async assignViaBrandRule(tx: Tx, taskId: string): Promise<string | undefined> {
    // Read ka_type and country from the task's form values
    const formValues = await tx.formValue.findMany({
      where: { taskId },
      include: { formField: { select: { tipo: true } } },
    });

    const kaTypeValue = formValues.find(fv => fv.formField?.tipo === 'select_ka_type')?.valor;
    const countryValue = formValues.find(fv => fv.formField?.tipo === 'select_country')?.valor;

    if (!kaTypeValue || !countryValue) {
      this.logger.warn(`brand_assignment: task ${taskId} missing ka_type or country form values`);
      return undefined;
    }

    const rule = await tx.brandAssignmentRule.findUnique({
      where: { kaType_country: { kaType: kaTypeValue as any, country: countryValue as any } },
      include: { candidates: true },
    });

    if (!rule || !rule.candidates.length) {
      this.logger.warn(`brand_assignment: no rule or candidates for ${kaTypeValue} × ${countryValue}`);
      return undefined;
    }

    if (rule.modo === 'fixed') {
      return rule.candidates[0].accountId;
    }

    // round_robin over BrandAssignmentRule pool (atomic, uses account.rrCounter)
    const accountIds = rule.candidates.map(c => c.accountId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM account
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY contador_rr ASC
      LIMIT 1
      FOR UPDATE
    `;
    if (!rows.length) return undefined;
    await tx.account.update({ where: { id: rows[0].id }, data: { rrCounter: { increment: 1 } } });
    return rows[0].id;
  }

  private async roundRobinFromStep(tx: Tx, stepDefId: string): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
      FROM step_definition_account sda
      JOIN account a ON a.id = sda.account_id
      WHERE sda.step_definition_id = ${stepDefId}::uuid
      ORDER BY a.contador_rr ASC
      LIMIT 1
      FOR UPDATE OF a
    `;
    if (!rows.length) return undefined;
    await tx.account.update({ where: { id: rows[0].id }, data: { rrCounter: { increment: 1 } } });
    return rows[0].id;
  }

  // ── Webhook helper ────────────────────────────────────────────────────────

  private async sendStepWebhook(stepDefinitionId: string, event: WebhookEvent, taskId: string) {
    const [task, stepInstance] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        include: {
          brand: true,
          taskType: true,
          createdBy: { select: { email: true, name: true } },
        },
      }),
      this.prisma.stepInstance.findFirst({
        where: { taskId, stepDefinitionId },
        include: {
          assignedTo:     { select: { email: true, name: true } },
          stepDefinition: { select: { name: true, order: true } },
        },
      }),
    ]);

    if (!task) return;

    const handle = (email: string | null | undefined) => email?.split('@')[0] ?? null;
    const bpoHandle     = handle(stepInstance?.assignedTo?.email);
    const creatorHandle = handle(task.createdBy?.email);

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
    const taskUrl     = `${frontendUrl}/tasks/${taskId}`;

    const colorMap: Record<WebhookEvent, string> = {
      on_start:      '#2196F3',
      on_complete:   '#4CAF50',
      on_fail:       '#F44336',
      on_assignment: '#9C27B0',
      on_blocked:    '#FF9800',
    };
    const eventLabel: Record<WebhookEvent, string> = {
      on_start:      'started',
      on_complete:   'completed',
      on_fail:       'failed',
      on_assignment: 'assigned',
      on_blocked:    'blocked',
    };

    const mentions = [bpoHandle && `@${bpoHandle}`, creatorHandle && `@${creatorHandle}`]
      .filter(Boolean).join(' ');

    const stepLabel = stepInstance?.stepDefinition
      ? `Step ${stepInstance.stepDefinition.order}: ${stepInstance.stepDefinition.name}`
      : null;

    const lines = [
      task.brand ? `🏷️ ${task.brand.brandName} (${task.brand.country})` : null,
      stepLabel     ? `📋 ${stepLabel}`                    : null,
      bpoHandle     ? `👤 BPO: @${bpoHandle}`              : null,
      creatorHandle ? `✏️ Created by: @${creatorHandle}`   : null,
      `🔗 ${taskUrl}`,
    ].filter(Boolean).join('\n');

    const payload = {
      text: `${mentions ? mentions + ' — ' : ''}**${task.taskType.name}** ${eventLabel[event]}${stepLabel ? ` (${stepLabel})` : ''}`,
      attachments: [{
        title: task.taskType.name,
        text:  lines,
        color: colorMap[event],
      }],
    };

    await this.webhookSender.sendForStep(stepDefinitionId, event, payload).catch((err) =>
      this.logger.error(`Webhook error: ${err.message}`),
    );
  }
}
