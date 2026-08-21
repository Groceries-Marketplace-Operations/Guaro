import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AssignmentStrategy,
  ExecutionType,
  Prisma,
  StepFailureReason,
  StepStatus,
  StoreOnboardingEnrollmentDecision,
  TaskStatus,
  WebhookEvent,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { StoreOnboardingLifecycleService } from '../store-onboarding/store-onboarding-lifecycle.service';

type Tx = Prisma.TransactionClient;
type LockedStep = Prisma.StepInstanceGetPayload<{
  include: { stepDefinition: { include: { candidates: true } }; task: true };
}>;
const HANDLER_FENCE_TIMEOUT_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

@Injectable()
export class TaskEngineService {
  private readonly logger = new Logger(TaskEngineService.name);
  private recoveringStoreOnboardingBrands = false;

  constructor(
    private prisma: PrismaService,
    private webhookSender: WebhookSenderService,
    @Optional() private storeOnboardingLifecycle?: StoreOnboardingLifecycleService,
  ) {}

  // ── Activate a step (just-in-time assignment) ─────────────────────────────
  // Manual steps: assign BPO + task→assigned (BPO must click "Start Review")
  // Automatic steps: assign + step→in_progress + task→in_progress immediately

  async activateStep(stepInstanceId: string, expectedTaskStatus?: TaskStatus): Promise<boolean> {
    let isAutomatic = false;
    let activated = false;

    await this.prisma.$transaction(async (tx) => {
      const step = await this.claimStepMutation(tx, stepInstanceId, false);
      if (!step) return;
      if (step.status !== StepStatus.pending) return;
      if (expectedTaskStatus && step.task.status !== expectedTaskStatus) return;
      if (
        step.stepDefinition.executionType !== ExecutionType.automatic
        && step.task.status === TaskStatus.assigned
        && step.workedSeconds !== null
      ) return;
      const assignedToId = await this.assignBpo(tx, step.stepDefinition, step.taskId, step.id);
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
          // workedSeconds=0 is the durable claim marker even when a manual
          // strategy intentionally leaves assignedToId empty.
          data: { assignedToId, workedSeconds: step.workedSeconds ?? 0 },
        });
        await tx.task.update({
          where: { id: step.taskId },
          data: { status: TaskStatus.assigned },
        });
      }
      activated = true;
    });

    if (!activated) return false;
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepInstanceId } });
    if (step) {
      if (isAutomatic) {
        await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_start, step.taskId);
      } else {
        // Manual step: BPO just got assigned, fire on_assignment
        await this.sendStepWebhook(step.stepDefinitionId, WebhookEvent.on_assignment, step.taskId);
      }
    }
    return true;
  }

  // ── BPO clicks "Start Review" ─────────────────────────────────────────────
  // Manual step: pending → in_progress, task assigned → in_progress

  async startStep(stepInstanceId: string): Promise<void> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
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
      return { taskId: step.taskId, stepDefinitionId: step.stepDefinitionId };
    });

    await this.sendStepWebhook(claimed.stepDefinitionId, WebhookEvent.on_start, claimed.taskId);
  }

  // ── Complete a step ───────────────────────────────────────────────────────

  async completeStep(stepInstanceId: string, result?: unknown, note?: string): Promise<void> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
      if (step.status !== StepStatus.in_progress) {
        throw new BadRequestException('Step must be in_progress to be completed');
      }
      const now = new Date();
      const currentPeriod = step.startedAt
        ? Math.floor((now.getTime() - step.startedAt.getTime()) / 1000)
        : 0;
      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.done,
          completedAt: now,
          result: result as Prisma.InputJsonValue ?? Prisma.JsonNull,
          note: note ?? null,
          workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
        },
      });
      // Cancel sibling instances for the same stepDefinition
      await tx.stepInstance.updateMany({
        where: {
          taskId: step.taskId,
          stepDefinitionId: step.stepDefinitionId,
          id: { not: stepInstanceId },
          status: { notIn: [StepStatus.done, StepStatus.failed, StepStatus.cancelled] },
        },
        data: { status: StepStatus.cancelled },
      });
      return { taskId: step.taskId, stepDefinitionId: step.stepDefinitionId };
    });

    const suppressLegacyCompletion = await this.shouldSuppressLegacyFinalCompletion(claimed.taskId);
    if (!suppressLegacyCompletion) {
      await this.sendStepWebhook(claimed.stepDefinitionId, WebhookEvent.on_complete, claimed.taskId);
    }
    await this.advanceTask(claimed.taskId);
  }

  // ── Fail a step ───────────────────────────────────────────────────────────

  async failStep(
    stepInstanceId: string,
    failureReason: StepFailureReason,
    note?: string,
  ): Promise<void> {
    const claimed = await this.prisma.$transaction(async tx => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
      if (step.status !== StepStatus.in_progress && step.status !== StepStatus.blocked) {
        throw new BadRequestException('Step must be active to be failed');
      }
      const now = new Date();
      const currentPeriod = step.startedAt
        ? Math.floor((now.getTime() - step.startedAt.getTime()) / 1000)
        : 0;
      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.failed,
          failureReason,
          note: note ?? null,
          completedAt: now,
          workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
        },
      });
      // Cancel sibling instances for the same stepDefinition
      await tx.stepInstance.updateMany({
        where: {
          taskId: step.taskId,
          stepDefinitionId: step.stepDefinitionId,
          id: { not: stepInstanceId },
          status: { notIn: [StepStatus.done, StepStatus.failed, StepStatus.cancelled] },
        },
        data: { status: StepStatus.cancelled },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.failed },
      });
      return { taskId: step.taskId, stepDefinitionId: step.stepDefinitionId };
    });

    await this.sendStepWebhook(claimed.stepDefinitionId, WebhookEvent.on_fail, claimed.taskId);
    await this.afterTerminalTask(claimed.taskId);
  }

  // ── Block a step (manual only) ────────────────────────────────────────────

  async blockStep(stepInstanceId: string, note?: string): Promise<void> {
    const claimed = await this.prisma.$transaction(async tx => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
      if (step.stepDefinition.executionType === ExecutionType.automatic) {
        throw new BadRequestException('Automatic steps cannot be blocked');
      }
      if (step.status !== StepStatus.in_progress) {
        throw new BadRequestException('Step must be in_progress to be blocked');
      }
      const elapsedSeconds = step.startedAt
        ? Math.floor((Date.now() - step.startedAt.getTime()) / 1000)
        : 0;
      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.blocked,
          note: note ?? null,
          workedSeconds: (step.workedSeconds ?? 0) + elapsedSeconds,
          startedAt: null,
        },
      });
      // Cancel sibling instances (pending or in_progress) for the same stepDefinition
      await tx.stepInstance.updateMany({
        where: {
          taskId: step.taskId,
          stepDefinitionId: step.stepDefinitionId,
          id: { not: stepInstanceId },
          status: { in: [StepStatus.pending, StepStatus.in_progress] },
        },
        data: { status: StepStatus.cancelled },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.blocked },
      });
      return { taskId: step.taskId, stepDefinitionId: step.stepDefinitionId };
    });

    await this.sendStepWebhook(claimed.stepDefinitionId, WebhookEvent.on_blocked, claimed.taskId);
  }

  // ── Retry a blocked step ──────────────────────────────────────────────────

  async retryStep(stepInstanceId: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
      if (step.status !== StepStatus.blocked) {
        throw new BadRequestException('Only blocked steps can be retried');
      }
      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: { status: StepStatus.in_progress, note: null, startedAt: new Date() },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.in_progress },
      });
    });
  }

  // ── Force-retry a failed or blocked step (admin/super_admin only) ─────────

  async forceRetryStep(stepInstanceId: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
      if (step.status !== StepStatus.failed && step.status !== StepStatus.blocked) {
        throw new BadRequestException('Only failed or blocked steps can be force-retried');
      }
      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          status: StepStatus.in_progress,
          note: null,
          failureReason: null,
          startedAt: new Date(),
          completedAt: null,
        },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: { status: TaskStatus.in_progress },
      });
    });
  }

  // ── Advance task to next step ─────────────────────────────────────────────
  // Finds all pending instances at the lowest step order and activates them all
  // (supports bpoCount > 1 for fixed/manual strategies).

  async advanceTask(taskId: string): Promise<void> {
    // Even if a caller bypasses TasksService, an unsatisfied shared Brand
    // prerequisite is a hard execution barrier.
    if (this.storeOnboardingLifecycle && await this.storeOnboardingLifecycle.isTaskBlockedByBrand(taskId)) return;

    const pendingInstances = await this.prisma.stepInstance.findMany({
      where: { taskId, status: StepStatus.pending },
      include: { stepDefinition: true },
      orderBy: { stepDefinition: { order: 'asc' } },
    });

    if (!pendingInstances.length) {
      const completed = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "task" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
        const task = await tx.task.findUnique({ where: { id: taskId }, select: { status: true } });
        if (!task || task.status === TaskStatus.done || task.status === TaskStatus.failed) return false;
        const activeSteps = await tx.stepInstance.count({
          where: {
            taskId,
            status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] },
          },
        });
        if (activeSteps > 0) return false;
        if (
          this.storeOnboardingLifecycle
          && !await this.storeOnboardingLifecycle.canActivateTaskInTransaction(tx, taskId)
        ) return false;
        await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.done } });
        return true;
      });
      if (!completed) return;
      await this.afterTerminalTask(taskId);
      return;
    }

    const minOrder = pendingInstances[0].stepDefinition.order;
    const nextInstances = pendingInstances.filter(i => i.stepDefinition.order === minOrder);

    const activatedInstanceIds = new Set<string>();
    for (const instance of nextInstances) {
      if (await this.activateStep(instance.id)) activatedInstanceIds.add(instance.id);
    }

    for (const instance of nextInstances) {
      if (
        activatedInstanceIds.has(instance.id)
        && instance.stepDefinition.executionType === ExecutionType.automatic
      ) {
        this.emitAutoStep(instance.id, instance.stepDefinition.handlerId!, taskId);
      }
    }
  }

  /**
   * Revalidates a Bull handler job after dequeue and holds the Store
   * Onboarding shared kill-switch fence for the complete external effect. A
   * per-Step advisory claim prevents two stale workers from running the same
   * handler concurrently. Legacy Tasks never consult the onboarding control.
   */
  async runAutomaticHandlerUnderFence(
    stepInstanceId: string,
    taskId: string,
    effect: () => Promise<
      | { status: 'completed'; result?: unknown; note?: string }
      | { status: 'failed'; failureReason: StepFailureReason; note?: string }
    >,
  ): Promise<boolean> {
    const enrolled = !!this.storeOnboardingLifecycle
      && await this.storeOnboardingLifecycle.isTaskEnrolled(taskId);
    if (!enrolled) {
      // Preserve the ffd6858 worker contract for legacy/excluded Tasks: the
      // potentially long handler runs outside an interactive Prisma
      // transaction, and the existing complete/fail methods persist only the
      // short terminal mutation afterwards.
      const outcome = await effect();
      if (outcome.status === 'completed') {
        await this.completeStep(stepInstanceId, outcome.result, outcome.note);
      } else {
        await this.failStep(stepInstanceId, outcome.failureReason, outcome.note);
      }
      return true;
    }

    const terminal = await this.prisma.$transaction(async tx => {
      const step = await this.claimStepMutation(tx, stepInstanceId, false);
      if (
        !step
        || step.taskId !== taskId
        || step.status !== StepStatus.in_progress
        || step.stepDefinition.executionType !== ExecutionType.automatic
      ) return null;
      const outcome = await effect();
      const now = new Date();
      const currentPeriod = step.startedAt
        ? Math.floor((now.getTime() - step.startedAt.getTime()) / 1000)
        : 0;
      if (outcome.status === 'completed') {
        await tx.stepInstance.update({
          where: { id: stepInstanceId },
          data: {
            status: StepStatus.done,
            completedAt: now,
            result: outcome.result as Prisma.InputJsonValue ?? Prisma.JsonNull,
            note: outcome.note ?? null,
            workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
          },
        });
        await tx.stepInstance.updateMany({
          where: {
            taskId,
            stepDefinitionId: step.stepDefinitionId,
            id: { not: stepInstanceId },
            status: { notIn: [StepStatus.done, StepStatus.failed, StepStatus.cancelled] },
          },
          data: { status: StepStatus.cancelled },
        });
      } else {
        await tx.stepInstance.update({
          where: { id: stepInstanceId },
          data: {
            status: StepStatus.failed,
            failureReason: outcome.failureReason,
            note: outcome.note ?? null,
            completedAt: now,
            workedSeconds: (step.workedSeconds ?? 0) + currentPeriod,
          },
        });
        await tx.stepInstance.updateMany({
          where: {
            taskId,
            stepDefinitionId: step.stepDefinitionId,
            id: { not: stepInstanceId },
            status: { notIn: [StepStatus.done, StepStatus.failed, StepStatus.cancelled] },
          },
          data: { status: StepStatus.cancelled },
        });
        await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.failed } });
      }
      return { ...outcome, stepDefinitionId: step.stepDefinitionId };
    }, { maxWait: 5_000, timeout: HANDLER_FENCE_TIMEOUT_MS });
    if (!terminal) return false;
    if (terminal.status === 'completed') {
      const suppressLegacyCompletion = await this.shouldSuppressLegacyFinalCompletion(taskId);
      if (!suppressLegacyCompletion) {
        await this.sendStepWebhook(terminal.stepDefinitionId, WebhookEvent.on_complete, taskId);
      }
      await this.advanceTask(taskId);
    } else {
      await this.sendStepWebhook(terminal.stepDefinitionId, WebhookEvent.on_fail, taskId);
      await this.afterTerminalTask(taskId);
    }
    return true;
  }

  // Overridden by QueueModule to publish the job (avoids circular dep)
  emitAutoStep: (stepInstanceId: string, handlerId: string, taskId: string) => void = () => undefined;

  // QueueModule checks whether the original/recovery Bull job is still live
  // before publishing. The activation epoch makes a later OFF -> ON cycle
  // independent from retained completed job ids from the previous cycle.
  recoverAutoStepJob: (
    stepInstanceId: string,
    handlerId: string,
    taskId: string,
    activationEpoch: string,
    executionGeneration: string,
  ) => Promise<boolean> = async () => false;

  @Cron('15,45 * * * * *')
  async recoverStoreOnboardingBrandTasks() {
    if (!this.storeOnboardingLifecycle || this.recoveringStoreOnboardingBrands) return;
    const control = await this.storeOnboardingLifecycle.control();
    if (!control.globalEnabled) return;
    this.recoveringStoreOnboardingBrands = true;
    try {
      const unblockedTaskIds = await this.storeOnboardingLifecycle.recoverTerminalBrandProvisionings();
      const stalledTaskIds = await this.storeOnboardingLifecycle.recoverEnrolledPendingTaskActivations();
      const handlerRecovery = await this.storeOnboardingLifecycle.recoverEnrolledAutomaticHandlerJobs();
      if (handlerRecovery.activationEpoch) {
        for (const step of handlerRecovery.steps) {
          await this.recoverAutoStepJob(
            step.stepInstanceId,
            step.handlerId,
            step.taskId,
            handlerRecovery.activationEpoch,
            step.executionGeneration,
          );
        }
      }
      for (const taskId of new Set([...unblockedTaskIds, ...stalledTaskIds])) {
        // Re-read the kill switch between recovered Tasks. A disable does not
        // cancel work already committed, but it prevents any subsequent Task
        // activation from this recovery pass.
        if (!(await this.storeOnboardingLifecycle.control()).globalEnabled) break;
        await this.advanceTask(taskId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Store Onboarding Brand recovery failed: ${message.slice(0, 500)}`);
    } finally {
      this.recoveringStoreOnboardingBrands = false;
    }
  }

  private async afterTerminalTask(taskId: string) {
    if (!this.storeOnboardingLifecycle) return;
    const reconciled = await this.storeOnboardingLifecycle.reconcileTaskAfterChange(taskId);
    for (const unblockedTaskId of reconciled.unblockedTaskIds) {
      await this.advanceTask(unblockedTaskId);
    }
  }

  private async shouldSuppressLegacyFinalCompletion(taskId: string) {
    if (!this.storeOnboardingLifecycle) return false;
    const control = await this.storeOnboardingLifecycle.control();
    if (!control.globalEnabled || !control.notificationsEnabled) return false;
    const [enrollment, remaining] = await Promise.all([
      this.prisma.storeOnboardingTaskEnrollment.findUnique({
        where: { taskId },
        select: { decision: true },
      }),
      this.prisma.stepInstance.count({
        where: { taskId, status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] } },
      }),
    ]);
    return enrollment?.decision === StoreOnboardingEnrollmentDecision.enrolled && remaining === 0;
  }

  // ── Human step assignment / reassignment ─────────────────────────────────

  async assignOrReassignStep(stepInstanceId: string, accountId: string): Promise<void> {
    let taskId = '';
    let stepDefinitionId = '';

    await this.prisma.$transaction(async (tx) => {
      const step = await this.claimStepMutation(tx, stepInstanceId);
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

      const now = new Date();
      const elapsedSeconds = step.status === StepStatus.in_progress && step.startedAt
        ? Math.max(0, Math.floor((now.getTime() - step.startedAt.getTime()) / 1000))
        : 0;

      await tx.stepInstance.update({
        where: { id: stepInstanceId },
        data: {
          assignedToId: accountId,
          ...(step.status === StepStatus.in_progress
            ? {
                workedSeconds: (step.workedSeconds ?? 0) + elapsedSeconds,
                startedAt: now,
              }
            : {}),
        },
      });
      await tx.task.update({
        where: { id: step.taskId },
        data: {
          status: step.status === StepStatus.pending
            ? TaskStatus.assigned
            : step.task.status,
        },
      });

      taskId = step.taskId;
      stepDefinitionId = step.stepDefinitionId;
    });

    await this.sendStepWebhook(stepDefinitionId, WebhookEvent.on_assignment, taskId);
  }

  private async lockStep(tx: Tx, stepInstanceId: string) {
    await tx.$queryRaw`SELECT "id" FROM "step_instance" WHERE "id" = ${stepInstanceId}::uuid FOR UPDATE`;
    return tx.stepInstance.findUnique({
      where: { id: stepInstanceId },
      include: { stepDefinition: { include: { candidates: true } }, task: true },
    });
  }

  private async claimStepMutation(tx: Tx, stepInstanceId: string): Promise<LockedStep>;
  private async claimStepMutation(tx: Tx, stepInstanceId: string, throwWhenBlocked: false): Promise<LockedStep | null>;
  private async claimStepMutation(
    tx: Tx,
    stepInstanceId: string,
    throwWhenBlocked = true,
  ): Promise<LockedStep | null> {
    const identity = await tx.stepInstance.findUnique({
      where: { id: stepInstanceId },
      select: { taskId: true },
    });
    if (!identity) throw new NotFoundException('StepInstance not found');
    if (
      this.storeOnboardingLifecycle
      && !await this.storeOnboardingLifecycle.canActivateTaskInTransaction(tx, identity.taskId)
    ) {
      if (!throwWhenBlocked) return null;
      throw new ConflictException('Store Onboarding is disabled or the Brand prerequisite is not ready');
    }
    const claimKey = `task-handler:${stepInstanceId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${claimKey}))`;
    const step = await this.lockStep(tx, stepInstanceId);
    if (!step) throw new NotFoundException('StepInstance not found');
    return step;
  }

  // ── Just-in-time assignment ───────────────────────────────────────────────

  private async assignBpo(
    tx: Tx,
    stepDef: { id: string; assignmentStrategy: AssignmentStrategy; weight: number; order: number },
    taskId: string,
    stepInstanceId: string,
  ): Promise<string | undefined> {

    // ── Manual: admin assigns at runtime, no automatic assignment ────────────
    if (stepDef.assignmentStrategy === AssignmentStrategy.manual) {
      return undefined;
    }

    // ── Same previous step: inherit the BPO from the last completed step ──────
    if (stepDef.assignmentStrategy === AssignmentStrategy.same_previous_step) {
      const prev = await tx.stepInstance.findFirst({
        where: {
          taskId,
          id: { not: stepInstanceId },
          assignedToId: { not: null },
          stepDefinition: { order: { lt: stepDef.order } },
        },
        orderBy: { stepDefinition: { order: 'desc' } },
        select: { assignedToId: true },
      });
      if (prev?.assignedToId) return prev.assignedToId;
      // Fallback: round_robin over the pool if no previous step has an assignee
      return this.roundRobinFromStep(tx, stepDef.id);
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
      // For bpoCount > 1: pick the next candidate based on how many siblings already have one
      const alreadyAssigned = await tx.stepInstance.count({
        where: { taskId, stepDefinitionId: stepDef.id, assignedToId: { not: null } },
      });
      return candidates[alreadyAssigned % candidates.length]?.accountId;
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
      bpoHandle     ? `👤 PoC: @${bpoHandle}`              : null,
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
