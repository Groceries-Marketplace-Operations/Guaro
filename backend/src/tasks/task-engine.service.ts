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

  async activateStep(stepInstanceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const step = await tx.stepInstance.findUnique({
        where: { id: stepInstanceId },
        include: { stepDefinition: { include: { candidates: true } }, task: true },
      });
      if (!step) throw new NotFoundException('StepInstance not found');
      if (step.status !== StepStatus.pending) return;

      const assignedToId = await this.assignBpo(tx, step.stepDefinition);

      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: { status: StepStatus.in_progress, assignedToId },
      });

      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.in_progress },
      });
    });

    // Webhook outside tx (best-effort)
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

    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: {
        status: StepStatus.done,
        completedAt: new Date(),
        result: result as Prisma.InputJsonValue ?? Prisma.JsonNull,
        note: note ?? null,
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

    await this.prisma.$transaction([
      this.prisma.stepInstance.update({
        where: { id: stepInstanceId },
        data: { status: StepStatus.failed, failureReason, note: note ?? null, completedAt: new Date() },
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

    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: { status: StepStatus.blocked, note: note ?? null },
    });
  }

  // ── Retry a blocked step ──────────────────────────────────────────────────

  async retryStep(stepInstanceId: string): Promise<void> {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (!step) throw new NotFoundException('StepInstance not found');
    if (step.status !== StepStatus.blocked) {
      throw new BadRequestException('Only blocked steps can be retried');
    }
    await this.prisma.stepInstance.update({
      where: { id: stepInstanceId },
      data: { status: StepStatus.in_progress, note: null },
    });
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
      this.emitAutoStep(nextStep.id, nextStep.stepDefinition.handlerId!);
    }
  }

  // Overridden by QueueModule to publish the job (avoids circular dep)
  emitAutoStep: (stepInstanceId: string, handlerId: string) => void = () => undefined;

  // ── Just-in-time assignment ───────────────────────────────────────────────

  private async assignBpo(tx: Tx, stepDef: { id: string; assignmentStrategy: AssignmentStrategy; weight: number }): Promise<string | undefined> {
    const candidates = await tx.stepDefinitionAccount.findMany({
      where: { stepDefinitionId: stepDef.id },
    });
    if (!candidates.length) return undefined;

    if (stepDef.assignmentStrategy === AssignmentStrategy.fixed) {
      return candidates[0].accountId;
    }

    if (stepDef.assignmentStrategy === AssignmentStrategy.round_robin) {
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
      await tx.account.update({ where: { id: rows[0].id }, data: { rrCounter: { increment: 1 } } });
      return rows[0].id;
    }

    // by_weight: lowest workload, increment by step weight
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
    await tx.account.update({ where: { id: rows[0].id }, data: { workload: { increment: stepDef.weight } } });
    return rows[0].id;
  }

  // ── Webhook helper ────────────────────────────────────────────────────────

  private async sendStepWebhook(stepDefinitionId: string, event: WebhookEvent, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { brand: true, taskType: true },
    });

    const colorMap: Record<WebhookEvent, string> = {
      on_start: '#2196F3',
      on_complete: '#4CAF50',
      on_fail: '#F44336',
    };

    const payload = {
      text: `[${task?.taskType.name ?? 'Task'}] ${event.replace('on_', '')} — ${task?.brand?.brandName ?? ''}`,
      attachments: [{
        title: task?.taskType.name ?? '',
        text: task?.brand ? `Brand: ${task.brand.brandName} (${task.brand.country})` : '',
        color: colorMap[event],
      }],
    };

    await this.webhookSender.sendForStep(stepDefinitionId, event, payload).catch((err) =>
      this.logger.error(`Webhook error: ${err.message}`),
    );
  }
}
