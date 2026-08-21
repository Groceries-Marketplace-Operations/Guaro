import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  BrandProvisioningStatus,
  Country,
  KaType,
  Prisma,
  StepStatus,
  StoreOnboardingEnrollmentDecision,
  StoreOnboardingOutboxStatus,
  StoreOnboardingSource,
  StoreOnboardingStage,
  StoreOnboardingStatus,
  TaskDependencyStatus,
  TaskStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type StoreOnboardingTx = Prisma.TransactionClient;

export type TaskLifecycleRegistration = {
  taskId: string;
  taskTypeId: string;
  createdAt: Date;
  scheduledStart: Date | null;
  createdById: string;
  brand: {
    id: string;
    country: Country;
    kaType: KaType;
    createdAt: Date;
  } | null;
};

type DomainEvent = {
  eventKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  requestId?: string;
  taskId?: string;
  unitId?: string;
  actorId?: string;
  payload: unknown;
};

export function calculateStoreOnboardingTimelineEffort(input: {
  batchStartedAt: Date;
  batchEndedAt: Date;
  dependency?: {
    startedAt: Date;
    satisfiedAt: Date | null;
    autoCompleted: boolean;
  } | null;
}) {
  const minutes = (start: Date, end: Date) => (
    Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
  );
  const dependencyStartedAt = input.dependency?.startedAt ?? input.batchStartedAt;
  const inclusiveStartedAt = dependencyStartedAt < input.batchStartedAt
    ? dependencyStartedAt
    : input.batchStartedAt;
  const ownStartedAt = !input.dependency || input.dependency.autoCompleted
    ? input.batchStartedAt
    : input.dependency.satisfiedAt
      ? (input.dependency.satisfiedAt > input.batchStartedAt
          ? input.dependency.satisfiedAt
          : input.batchStartedAt)
      : null;

  return {
    inclusiveStartedAt,
    ownStartedAt,
    inclusiveLeadTimeMinutes: minutes(inclusiveStartedAt, input.batchEndedAt),
    batchOwnTimeMinutes: ownStartedAt ? minutes(ownStartedAt, input.batchEndedAt) : 0,
  };
}

export function calculateStoreOnboardingStageInterval(input: {
  openedAt: Date;
  nextTransitionAt: Date | null;
  toStage: StoreOnboardingStage;
  currentStage: StoreOnboardingStage;
  now: Date;
}) {
  const terminalStages = new Set<StoreOnboardingStage>([
    StoreOnboardingStage.online,
    StoreOnboardingStage.cancelled,
    StoreOnboardingStage.no_coverage,
    StoreOnboardingStage.creation_failed,
  ]);
  const currentTerminal = !input.nextTransitionAt
    && input.currentStage === input.toStage
    && terminalStages.has(input.toStage);
  const endedAt = input.nextTransitionAt ?? (currentTerminal ? input.openedAt : input.now);
  return {
    startedAt: input.openedAt,
    endedAt,
    status: input.nextTransitionAt || currentTerminal ? 'completed' as const : 'current' as const,
    durationMinutes: Math.max(0, Math.round((endedAt.getTime() - input.openedAt.getTime()) / 60_000)),
  };
}

@Injectable()
export class StoreOnboardingLifecycleService {
  private readonly logger = new Logger(StoreOnboardingLifecycleService.name);
  private lastControlReadWarningAt = 0;
  private reconcilingTerminalTasks = false;

  constructor(private readonly prisma: PrismaService) {}

  async control(client: PrismaService | StoreOnboardingTx = this.prisma) {
    try {
      if (!await this.relationExists(client, 'public.store_onboarding_control')) {
        return this.disabledControl();
      }
      const row = await client.storeOnboardingControl.findUnique({ where: { id: 'default' } });
      return {
        globalEnabled: row?.globalEnabled ?? false,
        notificationsEnabled: row?.notificationsEnabled ?? false,
        globalEnabledAt: row?.globalEnabledAt ?? null,
        notificationsEnabledAt: row?.notificationsEnabledAt ?? null,
      };
    } catch (error) {
      const now = Date.now();
      if (now - this.lastControlReadWarningAt >= 60_000) {
        this.lastControlReadWarningAt = now;
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'unknown')
          : 'unknown';
        this.logger.warn(`Store Onboarding control unavailable (${code}); feature remains OFF`);
      }
      return this.disabledControl();
    }
  }

  /** Serializes the master kill-switch with every onboarding domain transaction. */
  async controlUnderDomainLock(tx: StoreOnboardingTx) {
    try {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('store-onboarding-control'))`;
    } catch (error) {
      // Task hooks must remain transparent during a rolling migration or DB
      // incompatibility. Returning OFF preserves the legacy Task path.
      return this.disabledControl();
    }
    return this.control(tx);
  }

  async assertEnabledInTransaction(tx: StoreOnboardingTx) {
    const control = await this.controlUnderDomainLock(tx);
    if (!control.globalEnabled) {
      throw new ConflictException('Store Onboarding is disabled; operational writes are blocked');
    }
    return control;
  }

  async isTaskBlockedByBrand(taskId: string) {
    try {
      if (!await this.relationExists(this.prisma, 'public.task_dependency')) return false;
      const dependency = await this.prisma.taskDependency.findFirst({
        where: { taskId, kind: 'brand_ready', status: { not: TaskDependencyStatus.satisfied } },
        select: { id: true },
      });
      return !!dependency;
    } catch {
      // A pre-migration/rolled-back runtime has no dependency barrier and must
      // preserve the legacy Task engine. Materialized barriers remain durable
      // even while the master switch is later turned OFF.
      return false;
    }
  }

  /**
   * Lightweight routing check for Bull workers. It deliberately ignores the
   * master switch: enrolled work needs the long shared fence, while legacy and
   * excluded Tasks must retain their original non-transactional handler path.
   */
  async isTaskEnrolled(taskId: string) {
    // A rolling deploy/rollback with no foundation table is unambiguously
    // legacy. Once the table exists, however, a read error must fail closed:
    // treating an unknown enrollment as legacy could run an external handler
    // without the shared master fence.
    if (!await this.relationExists(this.prisma, 'public.store_onboarding_task_enrollment')) return false;
    const enrollment = await this.prisma.storeOnboardingTaskEnrollment.findUnique({
      where: { taskId },
      select: { decision: true },
    });
    return enrollment?.decision === StoreOnboardingEnrollmentDecision.enrolled;
  }

  /**
   * Final activation fence used by TaskEngine in the same transaction that
   * mutates Step/Task state. Legacy and explicitly excluded Tasks are
   * transparent; an enrolled Task requires master ON and a satisfied Brand
   * dependency while holding the shared control lock through commit.
   */
  async canActivateTaskInTransaction(tx: StoreOnboardingTx, taskId: string) {
    if (!await this.relationExists(tx, 'public.store_onboarding_task_enrollment')) return true;
    const enrollment = await tx.storeOnboardingTaskEnrollment.findUnique({
      where: { taskId },
      select: { decision: true },
    });
    if (enrollment?.decision !== StoreOnboardingEnrollmentDecision.enrolled) return true;

    const control = await this.controlUnderDomainLock(tx);
    if (!control.globalEnabled) return false;
    if (!await this.relationExists(tx, 'public.task_dependency')) return false;
    const unsatisfiedDependency = await tx.taskDependency.findFirst({
      where: { taskId, kind: 'brand_ready', status: { not: TaskDependencyStatus.satisfied } },
      select: { id: true },
    });
    return !unsatisfiedDependency;
  }

  private disabledControl() {
    return {
      globalEnabled: false,
      notificationsEnabled: false,
      globalEnabledAt: null as Date | null,
      notificationsEnabledAt: null as Date | null,
    };
  }

  private async relationExists(client: PrismaService | StoreOnboardingTx, relation: string) {
    if (typeof (client as unknown as { $queryRaw?: unknown }).$queryRaw !== 'function') {
      // Unit-test doubles predating the rolling-schema guard represent an
      // available schema. Real Prisma clients always expose $queryRaw.
      return true;
    }
    const rows = await client.$queryRaw<Array<{ relation: string | null }>>`
      SELECT to_regclass(${relation})::text AS "relation"
    `;
    return rows[0]?.relation != null;
  }

  /** Recovers the crash window between Task terminal commit and request hydration. */
  @Cron('*/30 * * * * *')
  async reconcileTerminalTasks() {
    if (this.reconcilingTerminalTasks) return;
    const control = await this.control();
    if (!control.globalEnabled) return;
    this.reconcilingTerminalTasks = true;
    try {
      const pending = await this.prisma.storeOnboardingRequest.findMany({
        where: {
          OR: [
            { currentStage: StoreOnboardingStage.created, task: { status: TaskStatus.done } },
            { currentStage: { not: StoreOnboardingStage.creation_failed }, task: { status: TaskStatus.failed } },
          ],
        },
        select: { taskId: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const request of pending) {
        try {
          await this.reconcileTaskAfterChange(request.taskId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Store Onboarding terminal reconciliation failed (${request.taskId}): ${message.slice(0, 500)}`);
        }
      }
    } finally {
      this.reconcilingTerminalTasks = false;
    }
  }

  /**
   * Recovers the crash window after a Brand Task becomes terminal but before
   * TaskEngine invokes the lifecycle hook. Only already materialized
   * provisionings are scanned; this is never a historical Task backfill.
   */
  async recoverTerminalBrandProvisionings(limit = 100) {
    const control = await this.control();
    if (!control.globalEnabled) return [] as string[];

    const provisionings = await this.prisma.brandProvisioning.findMany({
      where: {
        autoCompleted: false,
        status: {
          in: [
            BrandProvisioningStatus.pending,
            BrandProvisioningStatus.failed,
            BrandProvisioningStatus.cancelled,
          ],
        },
      },
      select: {
        id: true,
        brandId: true,
        sourceTaskId: true,
        status: true,
        startedAt: true,
        sourceTask: { select: { status: true } },
        requests: {
          select: { rolloutRevision: { select: { brandTaskTypeId: true } } },
        },
      },
      orderBy: { startedAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
    });

    const unblockedTaskIds = new Set<string>();
    for (const provisioning of provisionings) {
      let terminalTaskId = provisioning.status === BrandProvisioningStatus.pending
        && provisioning.sourceTaskId
        && provisioning.sourceTask
        && (provisioning.sourceTask.status === TaskStatus.done
          || provisioning.sourceTask.status === TaskStatus.failed)
        ? provisioning.sourceTaskId
        : null;

      if (
        provisioning.status === BrandProvisioningStatus.failed
        || provisioning.status === BrandProvisioningStatus.cancelled
      ) {
        const frozenTaskTypeIds = [...new Set(
          provisioning.requests
            .map(request => request.rolloutRevision.brandTaskTypeId)
            .filter((taskTypeId): taskTypeId is string => !!taskTypeId),
        )];
        if (frozenTaskTypeIds.length) {
          const retry = await this.prisma.task.findFirst({
            where: {
              brandId: provisioning.brandId,
              taskTypeId: { in: frozenTaskTypeIds },
              id: provisioning.sourceTaskId ? { not: provisioning.sourceTaskId } : undefined,
              createdAt: { gt: provisioning.startedAt },
              status: { in: [TaskStatus.done, TaskStatus.failed] },
              deletedAt: null,
            },
            select: { id: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          });
          terminalTaskId = retry?.id ?? null;
        }
      }

      if (!terminalTaskId) continue;
      try {
        const reconciled = await this.reconcileTaskAfterChange(terminalTaskId);
        for (const taskId of reconciled.unblockedTaskIds) unblockedTaskIds.add(taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Store Onboarding Brand terminal recovery failed (${provisioning.id}): ${message.slice(0, 500)}`,
        );
      }
    }
    return [...unblockedTaskIds];
  }

  /**
   * Bounded recovery for the narrow crash/kill-switch window where an already
   * enrolled Task is pending with a ready Brand but no Step was claimed. It
   * never discovers historical or excluded Tasks and performs no writes.
   */
  async recoverEnrolledPendingTaskActivations(limit = 100) {
    const control = await this.control();
    if (!control.globalEnabled) return [] as string[];
    try {
      if (!await this.relationExists(this.prisma, 'public.store_onboarding_task_enrollment')) return [];
      const enrollments = await this.prisma.storeOnboardingTaskEnrollment.findMany({
        where: {
          decision: StoreOnboardingEnrollmentDecision.enrolled,
          task: {
            OR: [
              {
                status: TaskStatus.pending,
                stepInstances: { some: { status: StepStatus.pending } },
              },
              {
                status: TaskStatus.in_progress,
                stepInstances: {
                  none: { status: { in: [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked] } },
                },
              },
            ],
            storeOnboardingDependencies: {
              none: { kind: 'brand_ready', status: { not: TaskDependencyStatus.satisfied } },
            },
          },
        },
        select: { taskId: true },
        orderBy: { taskCreatedAt: 'asc' },
        take: Math.min(Math.max(limit, 1), 500),
      });
      return enrollments.map(enrollment => enrollment.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Store Onboarding pending activation recovery unavailable: ${message.slice(0, 300)}`);
      return [] as string[];
    }
  }

  /**
   * Finds automatic handlers that were durably claimed before the master was
   * disabled but whose Bull job was subsequently consumed by the OFF fence.
   * The ON timestamp is returned as a durable queue epoch: retries within the
   * same activation deduplicate, while a later OFF -> ON cycle gets a fresh
   * job id even if Bull still retains the completed job from the prior cycle.
   *
   * This method performs no domain writes. QueueModule checks the live Bull
   * job state before publishing and TaskEngine revalidates the Step under its
   * existing shared control/advisory fence before executing any handler.
   */
  async recoverEnrolledAutomaticHandlerJobs(limit = 100) {
    try {
      if (!await this.relationExists(this.prisma, 'public.store_onboarding_task_enrollment')) {
        return { activationEpoch: null as string | null, steps: [] as Array<{
          stepInstanceId: string;
          taskId: string;
          handlerId: string;
          executionGeneration: string;
        }> };
      }
      return this.prisma.$transaction(async tx => {
        const control = await this.controlUnderDomainLock(tx);
        if (!control.globalEnabled || !control.globalEnabledAt) {
          return { activationEpoch: null as string | null, steps: [] as Array<{
            stepInstanceId: string;
            taskId: string;
            handlerId: string;
            executionGeneration: string;
          }> };
        }
        const rows = await tx.stepInstance.findMany({
          where: {
            status: StepStatus.in_progress,
            stepDefinition: {
              executionType: 'automatic',
              handlerId: { not: null },
            },
            task: {
              status: TaskStatus.in_progress,
              storeOnboardingEnrollment: {
                decision: StoreOnboardingEnrollmentDecision.enrolled,
              },
              storeOnboardingDependencies: {
                none: { kind: 'brand_ready', status: { not: TaskDependencyStatus.satisfied } },
              },
            },
          },
          select: {
            id: true,
            taskId: true,
            startedAt: true,
            updatedAt: true,
            stepDefinition: { select: { handlerId: true } },
          },
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          take: Math.min(Math.max(limit, 1), 500),
        });
        return {
          activationEpoch: String(control.globalEnabledAt.getTime()),
          steps: rows.map(row => ({
            stepInstanceId: row.id,
            taskId: row.taskId,
            // The query predicate makes this non-null; retaining the guard
            // keeps the recovery payload safe if a handler is removed later.
            handlerId: row.stepDefinition.handlerId!,
            // forceRetry writes a fresh startedAt. Including that durable
            // execution generation prevents a retained failed Bull job from
            // suppressing the next attempt in the same master-ON epoch.
            executionGeneration: String((row.startedAt ?? row.updatedAt).getTime()),
          })),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Store Onboarding automatic-handler recovery unavailable: ${message.slice(0, 300)}`);
      return { activationEpoch: null as string | null, steps: [] as Array<{
        stepInstanceId: string;
        taskId: string;
        handlerId: string;
        executionGeneration: string;
      }> };
    }
  }

  /**
   * Runs inside the Task creation transaction. The first read is the singleton
   * control; OFF returns immediately and creates no onboarding row of any kind.
   */
  async registerTaskAtCreation(tx: StoreOnboardingTx, input: TaskLifecycleRegistration) {
    const control = await this.controlUnderDomainLock(tx);
    if (!control.globalEnabled) {
      return { relevant: false, enrolled: false, blockedByBrand: false, reason: 'global_off' as const };
    }

    const publishedRevisions = await tx.storeOnboardingRolloutRevision.findMany({
      where: {
        effectiveAt: { lte: input.createdAt },
        activatedAt: { not: null, lte: input.createdAt },
      },
      select: {
        id: true,
        country: true,
        kaType: true,
        revision: true,
        enabled: true,
        effectiveAt: true,
        activatedAt: true,
        workflowVersion: true,
        newRequestsOnly: true,
        brandTaskTypeId: true,
        sourceTaskTypes: {
          select: { source: true, taskTypeId: true },
        },
      },
      orderBy: [
        { country: 'asc' },
        { kaType: 'asc' },
        { effectiveAt: 'desc' },
        { revision: 'desc' },
      ],
    });
    const runtimeByScope = new Map<string, (typeof publishedRevisions)[number]>();
    for (const revision of publishedRevisions) {
      const key = `${revision.country}:${revision.kaType}`;
      if (!runtimeByScope.has(key)) runtimeByScope.set(key, revision);
    }
    const enabledRuntimeRevisions = [...runtimeByScope.values()]
      .filter(revision => revision.enabled);
    const knownMapping = enabledRuntimeRevisions
      .flatMap(revision => revision.sourceTaskTypes)
      .find(mapping => mapping.taskTypeId === input.taskTypeId);
    const isBrandPrerequisiteTaskType = enabledRuntimeRevisions
      .some(revision => revision.brandTaskTypeId === input.taskTypeId);
    if (!input.brand) {
      if (knownMapping || isBrandPrerequisiteTaskType) {
        throw new UnprocessableEntityException(
          isBrandPrerequisiteTaskType
            ? 'This Task Type is published as a Store Onboarding Brand prerequisite and requires a Brand before the Task can be created'
            : 'This Task Type is published for Store Onboarding and requires a Brand before the Task can be created',
        );
      }
      return { relevant: false, enrolled: false, blockedByBrand: false, reason: 'task_type_not_mapped' as const };
    }

    // Select the latest runtime revision for the Task's immutable scope first.
    // Filtering by Task Type in this lookup would allow an older revision to
    // reappear after the scope was disabled or remapped.
    const rollout = runtimeByScope.get(`${input.brand.country}:${input.brand.kaType}`) ?? null;
    const mapping = rollout?.sourceTaskTypes.find(item => item.taskTypeId === input.taskTypeId);
    if (!mapping) {
      if (isBrandPrerequisiteTaskType) {
        return {
          relevant: false,
          enrolled: false,
          blockedByBrand: false,
          reason: 'brand_prerequisite_task' as const,
        };
      }
      const wasEverPublishedAsSource = publishedRevisions.some(revision => (
        revision.sourceTaskTypes.some(item => item.taskTypeId === input.taskTypeId)
      ));
      return {
        relevant: wasEverPublishedAsSource,
        enrolled: false,
        blockedByBrand: false,
        reason: wasEverPublishedAsSource ? 'source_not_mapped' as const : 'task_type_not_mapped' as const,
      };
    }

    const existing = await tx.storeOnboardingTaskEnrollment.findUnique({ where: { taskId: input.taskId } });
    if (existing) {
      return {
        relevant: true,
        enrolled: existing.decision === StoreOnboardingEnrollmentDecision.enrolled,
        blockedByBrand: false,
        enrollment: existing,
        reason: existing.reason,
      };
    }

    const afterGlobalActivation = !!control.globalEnabledAt
      && input.createdAt.getTime() >= control.globalEnabledAt.getTime();
    const afterRolloutActivation = !!rollout?.activatedAt
      && input.createdAt.getTime() >= rollout.activatedAt.getTime();
    const enrolled = !!rollout
      && !!mapping
      && rollout.enabled
      && rollout.newRequestsOnly
      && afterGlobalActivation
      && afterRolloutActivation;
    const reason = !rollout
      ? 'no_effective_rollout'
      : !rollout.enabled
        ? 'scope_disabled'
        : !afterGlobalActivation
          ? 'before_global_activation'
          : !afterRolloutActivation
            ? 'before_rollout_activation'
            : !mapping
              ? 'source_not_mapped'
              : 'eligible';
    const source = mapping.source;
    const eligibilitySnapshot: Prisma.InputJsonObject = {
      evaluatedAt: input.createdAt.toISOString(),
      taskCreatedAt: input.createdAt.toISOString(),
      globalEnabled: control.globalEnabled,
      globalEnabledAt: control.globalEnabledAt?.toISOString() ?? null,
      country: input.brand.country,
      kaType: input.brand.kaType,
      source,
      reason,
      rolloutRevisionId: rollout?.id ?? null,
      rolloutEffectiveAt: rollout?.effectiveAt.toISOString() ?? null,
      rolloutActivatedAt: rollout?.activatedAt?.toISOString() ?? null,
      newRequestsOnly: rollout?.newRequestsOnly ?? true,
    };
    const enrollment = await tx.storeOnboardingTaskEnrollment.create({
      data: {
        taskId: input.taskId,
        decision: enrolled
          ? StoreOnboardingEnrollmentDecision.enrolled
          : StoreOnboardingEnrollmentDecision.excluded,
        source,
        reason,
        rolloutRevisionId: rollout?.id ?? null,
        countrySnapshot: input.brand.country,
        kaTypeSnapshot: input.brand.kaType,
        workflowVersion: enrolled ? rollout!.workflowVersion : null,
        taskCreatedAt: input.createdAt,
        evaluatedAt: input.createdAt,
        eligibilitySnapshot,
      },
    });
    if (!enrolled) {
      return { relevant: true, enrolled: false, blockedByBrand: false, enrollment, reason };
    }

    const provisioning = await this.ensureBrandProvisioning(tx, input, rollout!.brandTaskTypeId);
    const dependencyStatus = this.dependencyStatus(provisioning.status);
    const dependency = await tx.taskDependency.create({
      data: {
        taskId: input.taskId,
        prerequisiteTaskId: provisioning.sourceTaskId,
        brandProvisioningId: provisioning.id,
        status: dependencyStatus,
        autoCompleted: provisioning.autoCompleted,
        startedAt: provisioning.autoCompleted ? input.createdAt : provisioning.startedAt,
        satisfiedAt: provisioning.status === BrandProvisioningStatus.ready
          ? (provisioning.autoCompleted ? input.createdAt : provisioning.readyAt)
          : null,
      },
    });
    const blockedByBrand = dependencyStatus !== TaskDependencyStatus.satisfied;
    if (blockedByBrand) {
      await tx.task.update({ where: { id: input.taskId }, data: { status: TaskStatus.blocked } });
    }
    const request = await tx.storeOnboardingRequest.create({
      data: {
        brandId: input.brand.id,
        taskId: input.taskId,
        source,
        status: blockedByBrand ? StoreOnboardingStatus.blocked : StoreOnboardingStatus.active,
        currentStage: blockedByBrand ? StoreOnboardingStage.blocked : StoreOnboardingStage.created,
        rolloutRevisionId: rollout!.id,
        workflowVersion: rollout!.workflowVersion,
        countrySnapshot: input.brand.country,
        kaTypeSnapshot: input.brand.kaType,
        enrollmentSnapshot: eligibilitySnapshot,
        brandProvisioningId: provisioning.id,
        createdById: input.createdById,
        startedAt: input.createdAt,
      },
    });
    await tx.storeOnboardingBatch.create({
      data: {
        requestId: request.id,
        ordinal: 1,
        label: 'Batch 1',
        brandProvisioningId: provisioning.id,
        startedAt: input.createdAt,
      },
    });
    await this.enqueueDomainEvent(tx, {
      eventKey: `task-enrollment:${input.taskId}`,
      eventType: 'request.enrolled',
      aggregateType: 'store_onboarding_request',
      aggregateId: request.id,
      requestId: request.id,
      taskId: input.taskId,
      actorId: input.createdById,
      payload: {
        taskId: input.taskId,
        source,
        country: input.brand.country,
        kaType: input.brand.kaType,
        workflowVersion: rollout!.workflowVersion,
        rolloutRevisionId: rollout!.id,
        brandDependency: {
          provisioningId: provisioning.id,
          status: dependency.status,
          autoCompleted: dependency.autoCompleted,
        },
      },
    }, control);
    return { relevant: true, enrolled: true, blockedByBrand, enrollment, provisioning, dependency, request, reason };
  }

  /**
   * Idempotent post-Task hook. OFF returns before reading Task/enrollment and
   * therefore cannot create requests, dependencies or outbox events.
   */
  async reconcileTaskAfterChange(taskId: string) {
    const control = await this.control();
    if (!control.globalEnabled) {
      return { changed: false, requestId: null as string | null, unblockedTaskIds: [] as string[] };
    }

    return this.prisma.$transaction(async tx => {
      const lockedControl = await this.controlUnderDomainLock(tx);
      if (!lockedControl.globalEnabled) {
        return { changed: false, requestId: null as string | null, unblockedTaskIds: [] as string[] };
      }
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: {
          brand: { select: { id: true, country: true, kaType: true, ownerId: true } },
          taskShops: { include: { shop: true } },
          stepInstances: { select: { id: true, completedAt: true }, orderBy: { createdAt: 'asc' } },
          storeOnboardingEnrollment: true,
        },
      });
      if (!task) return { changed: false, requestId: null as string | null, unblockedTaskIds: [] as string[] };

      const unblockedTaskIds = await this.reconcileBrandProvisioning(tx, task.id, task.status, lockedControl);
      if (task.storeOnboardingEnrollment?.decision !== StoreOnboardingEnrollmentDecision.enrolled) {
        return { changed: unblockedTaskIds.length > 0, requestId: null as string | null, unblockedTaskIds };
      }
      if (task.status === TaskStatus.done) {
        const request = await this.ensureRequestForTask(tx, task, lockedControl);
        return { changed: true, requestId: request.id, unblockedTaskIds };
      }
      if (task.status === TaskStatus.failed) {
        const request = await tx.storeOnboardingRequest.findUnique({ where: { taskId: task.id } });
        if (request) {
          await tx.storeOnboardingRequest.update({
            where: { id: request.id },
            data: {
              status: 'blocked',
              currentStage: StoreOnboardingStage.creation_failed,
              lastError: 'Store creation Task failed',
            },
          });
          await this.enqueueDomainEvent(tx, {
            eventKey: `request:${request.id}:creation-failed`,
            eventType: 'request.blocked',
            aggregateType: 'store_onboarding_request',
            aggregateId: request.id,
            requestId: request.id,
            taskId: task.id,
            payload: { requestId: request.id, taskId: task.id },
          }, lockedControl);
          return { changed: true, requestId: request.id, unblockedTaskIds };
        }
      }
      return { changed: unblockedTaskIds.length > 0, requestId: null as string | null, unblockedTaskIds };
    });
  }

  async assertEnrolledTask(taskId: string) {
    const enrollment = await this.prisma.storeOnboardingTaskEnrollment.findUnique({ where: { taskId } });
    if (!enrollment || enrollment.decision !== StoreOnboardingEnrollmentDecision.enrolled) {
      throw new ConflictException('Task is not enrolled in Store Onboarding');
    }
    if (
      !enrollment.rolloutRevisionId
      || !enrollment.countrySnapshot
      || !enrollment.kaTypeSnapshot
      || !enrollment.workflowVersion
    ) {
      throw new ConflictException('Enrolled Task is missing its immutable rollout snapshot');
    }
    const dependency = await this.prisma.taskDependency.findFirst({
      where: { taskId, kind: 'brand_ready' },
      orderBy: { createdAt: 'desc' },
    });
    if (!dependency || dependency.status !== TaskDependencyStatus.satisfied) {
      throw new ConflictException('Brand prerequisite is not ready');
    }
    return { enrollment, dependency };
  }

  async timeline(requestId: string, options: { page?: number; limit?: number; unitId?: string }) {
    const control = await this.control();
    if (!control.globalEnabled) {
      throw new ConflictException('Store Onboarding is disabled');
    }
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const request = await this.prisma.storeOnboardingRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        taskId: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        estimatedCompletionAt: true,
        totalUnits: true,
        completedUnits: true,
        batches: {
          select: { id: true, ordinal: true, label: true, startedAt: true, completedAt: true },
          orderBy: { ordinal: 'asc' },
        },
        task: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            taskType: { select: { name: true } },
            stepInstances: {
              select: {
                id: true,
                status: true,
                createdAt: true,
                startedAt: true,
                completedAt: true,
                updatedAt: true,
                workedSeconds: true,
                note: true,
                assignedTo: { select: { id: true, name: true, email: true } },
                stepDefinition: { select: { name: true, order: true } },
              },
              orderBy: [{ stepDefinition: { order: 'asc' } }, { createdAt: 'asc' }],
            },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    const now = new Date();
    const minutes = (start: Date, end: Date) => Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
    const primaryBatch = request.batches[0] ?? null;
    const taskSegments = [
      {
        id: `task-created:${request.task.id}`,
        eventId: `task-created:${request.task.id}`,
        type: 'task_created',
        label: `2. ${request.task.taskType.name} · Task creado`,
        kind: 'actual',
        status: 'completed',
        startedAt: request.task.createdAt,
        endedAt: request.task.createdAt,
        durationMinutes: 0,
        batchId: primaryBatch?.id ?? null,
        batchLabel: primaryBatch?.label ?? 'Batch 1',
        metadata: { taskId: request.task.id, batchId: primaryBatch?.id ?? null },
      },
      ...request.task.stepInstances.map(step => {
        const startedAt = step.startedAt ?? step.createdAt;
        const terminal = step.completedAt ?? (['done', 'failed', 'cancelled'].includes(step.status) ? step.updatedAt : null);
        const blocked = step.status === 'blocked' || step.status === 'failed';
        return {
          id: `task-step:${step.id}`,
          eventId: terminal ? `task-step:${step.id}:${step.status}` : null,
          type: 'task_step',
          label: `2.${step.stepDefinition.order} ${step.stepDefinition.name}`,
          kind: blocked ? 'blocked' : 'actual',
          status: terminal ? 'completed' : blocked ? 'blocked' : step.status,
          stage: `task_${step.status}`,
          startedAt,
          endedAt: terminal,
          durationMinutes: step.workedSeconds != null
            ? Math.max(0, Math.round(step.workedSeconds / 60))
            : minutes(startedAt, terminal ?? now),
          batchId: primaryBatch?.id ?? null,
          batchLabel: primaryBatch?.label ?? 'Batch 1',
          actor: step.assignedTo,
          owner: step.assignedTo,
          note: step.note,
          metadata: {
            taskId: request.task.id,
            stepInstanceId: step.id,
            stepOrder: step.stepDefinition.order,
            batchId: primaryBatch?.id ?? null,
          },
        };
      }),
    ];
    const dependency = await this.prisma.taskDependency.findFirst({
      where: { taskId: request.taskId, kind: 'brand_ready' },
      orderBy: { createdAt: 'desc' },
    });
    const sharedBatchCount = dependency
      ? await this.prisma.storeOnboardingBatch.count({
        where: { brandProvisioningId: dependency.brandProvisioningId },
      })
      : 0;
    const where: Prisma.StoreOnboardingTransitionWhereInput = {
      unit: { requestId, ...(options.unitId ? { id: options.unitId } : {}) },
    };
    const [transitionTotal, units] = await Promise.all([
      this.prisma.storeOnboardingTransition.count({ where }),
      this.prisma.storeOnboardingUnit.findMany({ where: { requestId }, select: { stage: true } }),
    ]);
    const offset = (page - 1) * limit;
    const taskPage = taskSegments.slice(offset, offset + limit);
    const transitionTake = Math.max(0, limit - taskPage.length);
    const transitionSkip = Math.max(0, offset - taskSegments.length);
    const rows = transitionTake ? await this.prisma.storeOnboardingTransition.findMany({
        where,
        include: {
          unit: {
            select: {
              id: true,
              batchId: true,
              externalShopId: true,
              stage: true,
              createdAt: true,
              batch: { select: { label: true, ordinal: true } },
            },
          },
          actor: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: transitionSkip,
        take: transitionTake,
      }) : [];
    // A transition event opens its toStage. Its interval ends at the next
    // transition for that Unit, not at the event that opened it. Build all
    // successors present on this page and fetch only the global successor for
    // each Unit's last row so pagination never resets stage duration.
    const nextByTransition = new Map<string, Date>();
    const lastByUnit = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const previous = lastByUnit.get(row.unitId);
      if (previous) nextByTransition.set(previous.id, row.createdAt);
      lastByUnit.set(row.unitId, row);
    }
    const successorEntries = await Promise.all([...lastByUnit.values()].map(async row => {
      const successor = await this.prisma.storeOnboardingTransition.findFirst({
        where: {
          unitId: row.unitId,
          OR: [
            { createdAt: { gt: row.createdAt } },
            { createdAt: row.createdAt, id: { gt: row.id } },
          ],
        },
        select: { createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return [row.id, successor?.createdAt ?? null] as const;
    }));
    for (const [transitionId, successorAt] of successorEntries) {
      if (successorAt) nextByTransition.set(transitionId, successorAt);
    }
    const transitionData = rows.map(row => {
      const successorAt = nextByTransition.get(row.id) ?? null;
      const interval = calculateStoreOnboardingStageInterval({
        openedAt: row.createdAt,
        nextTransitionAt: successorAt,
        toStage: row.toStage,
        currentStage: row.unit.stage,
        now,
      });
      const rawMetadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata as Prisma.JsonObject
        : {};
      return {
        id: row.id,
        eventId: row.id,
        type: 'stage_transition',
        unitId: row.unitId,
        batchId: row.unit.batchId,
        batchLabel: row.unit.batch.label,
        batchOrdinal: row.unit.batch.ordinal,
        externalShopId: row.unit.externalShopId,
        label: row.toStage.replaceAll('_', ' '),
        kind: row.toStage === StoreOnboardingStage.blocked ? 'blocked' : 'actual',
        fromStage: row.fromStage,
        toStage: row.toStage,
        stage: row.toStage,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes,
        status: interval.status,
        actor: row.actor,
        metadata: { ...rawMetadata, batchId: row.unit.batchId, batchLabel: row.unit.batch.label },
        note: row.note,
      };
    });
    const data = [...taskPage, ...transitionData];
    const batchStartedAt = request.startedAt ?? request.createdAt;
    const batchEndedAt = request.completedAt ?? now;
    const effort = calculateStoreOnboardingTimelineEffort({
      batchStartedAt,
      batchEndedAt,
      dependency,
    });
    const brandDependency = dependency ? {
      status: dependency.status,
      sourceTaskId: dependency.prerequisiteTaskId,
      startedAt: dependency.startedAt,
      readyAt: dependency.satisfiedAt,
      elapsedMinutes: dependency.autoCompleted ? 0 : minutes(dependency.startedAt, dependency.satisfiedAt ?? now),
      durationMinutes: dependency.autoCompleted ? 0 : minutes(dependency.startedAt, dependency.satisfiedAt ?? now),
      autoCompleted: dependency.autoCompleted,
      sharedBatchCount,
      sharedEffortKey: dependency.brandProvisioningId,
    } : null;
    return {
      data,
      batches: request.batches,
      summary: {
        startedAt: effort.inclusiveStartedAt,
        batchOwnStartedAt: effort.ownStartedAt,
        estimatedCompletionAt: request.estimatedCompletionAt,
        inclusiveLeadTimeMinutes: effort.inclusiveLeadTimeMinutes,
        batchOwnTimeMinutes: effort.batchOwnTimeMinutes,
        completedUnits: request.completedUnits,
        activeUnits: units.filter(unit => unit.stage !== StoreOnboardingStage.online && unit.stage !== StoreOnboardingStage.cancelled).length,
        blockedUnits: units.filter(unit => unit.stage === StoreOnboardingStage.blocked || unit.stage === StoreOnboardingStage.audit_needs_information).length,
        brandDependency,
      },
      page,
      limit,
      total: taskSegments.length + transitionTotal,
    };
  }

  async enqueueDomainEvent(
    tx: StoreOnboardingTx,
    event: DomainEvent,
    knownControl?: { globalEnabled: boolean; notificationsEnabled: boolean },
  ) {
    const control = knownControl ?? await this.control(tx);
    if (!control.globalEnabled || !control.notificationsEnabled) return null;
    const occurredAt = new Date();
    return tx.storeOnboardingOutboxEvent.upsert({
      where: { eventKey: event.eventKey },
      create: {
        eventKey: event.eventKey,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        requestId: event.requestId,
        taskId: event.taskId,
        unitId: event.unitId,
        payload: JSON.parse(JSON.stringify({
          eventId: event.eventKey,
          eventType: event.eventType,
          occurredAt: occurredAt.toISOString(),
          actorId: event.actorId ?? null,
          ...((event.payload && typeof event.payload === 'object') ? event.payload as object : { value: event.payload }),
        })) as Prisma.InputJsonValue,
        status: StoreOnboardingOutboxStatus.pending,
        occurredAt,
        availableAt: occurredAt,
      },
      update: {},
    });
  }

  private async ensureBrandProvisioning(
    tx: StoreOnboardingTx,
    input: TaskLifecycleRegistration,
    brandTaskTypeId: string | null,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'store-onboarding-brand:' + input.brand!.id}))`;
    const brandTask = brandTaskTypeId ? await tx.task.findFirst({
      where: {
        id: { not: input.taskId },
        brandId: input.brand!.id,
        taskTypeId: brandTaskTypeId,
        createdAt: { lte: input.createdAt },
        deletedAt: null,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        stepInstances: { select: { completedAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    }) : null;
    const existing = await tx.brandProvisioning.findUnique({ where: { brandId: input.brand!.id } });
    if (existing) {
      const retryable = existing.status === BrandProvisioningStatus.failed
        || existing.status === BrandProvisioningStatus.cancelled;
      const laterTask = !!brandTask
        && brandTask.id !== existing.sourceTaskId
        && brandTask.createdAt > existing.startedAt;
      if (!retryable || !laterTask) return existing;

      const retryReadyAt = brandTask.status === TaskStatus.done
        ? brandTask.stepInstances.reduce<Date | null>((latest, step) => (
            step.completedAt && (!latest || step.completedAt > latest) ? step.completedAt : latest
          ), null) ?? brandTask.updatedAt
        : null;
      const nextStatus = brandTask.status === TaskStatus.done
        ? BrandProvisioningStatus.ready
        : brandTask.status === TaskStatus.failed
          ? BrandProvisioningStatus.failed
          : BrandProvisioningStatus.pending;
      const recovered = await tx.brandProvisioning.update({
        where: { id: existing.id },
        data: {
          sourceTaskId: brandTask.id,
          status: nextStatus,
          autoCompleted: false,
          startedAt: brandTask.createdAt,
          readyAt: retryReadyAt,
          failedAt: nextStatus === BrandProvisioningStatus.failed ? brandTask.updatedAt : null,
          lastError: nextStatus === BrandProvisioningStatus.failed
            ? 'Brand creation retry Task failed'
            : nextStatus === BrandProvisioningStatus.pending
              ? 'Brand creation retry in progress'
              : null,
        },
      });
      const retryDependencyStatus = this.dependencyStatus(nextStatus);
      const dependencies = await tx.taskDependency.findMany({
        where: {
          brandProvisioningId: existing.id,
          status: { in: [TaskDependencyStatus.waiting, TaskDependencyStatus.failed, TaskDependencyStatus.cancelled] },
        },
        select: { id: true, taskId: true },
      });
      if (dependencies.length) {
        await tx.taskDependency.updateMany({
          where: { id: { in: dependencies.map(item => item.id) } },
          data: {
            prerequisiteTaskId: brandTask.id,
            status: retryDependencyStatus,
            autoCompleted: false,
            startedAt: brandTask.createdAt,
            satisfiedAt: nextStatus === BrandProvisioningStatus.ready ? retryReadyAt : null,
          },
        });
        if (nextStatus === BrandProvisioningStatus.ready) {
          const blockedTasks = await tx.task.findMany({
            where: { id: { in: dependencies.map(item => item.taskId) }, status: TaskStatus.blocked },
            select: { id: true, scheduledStart: true },
          });
          const now = new Date();
          for (const task of blockedTasks) {
            await tx.task.update({
              where: { id: task.id },
              data: { status: task.scheduledStart && task.scheduledStart > now ? TaskStatus.scheduled : TaskStatus.pending },
            });
          }
          await tx.storeOnboardingRequest.updateMany({
            where: { taskId: { in: dependencies.map(item => item.taskId) }, currentStage: StoreOnboardingStage.blocked },
            data: { status: StoreOnboardingStatus.active, currentStage: StoreOnboardingStage.created, lastError: null },
          });
        } else {
          await tx.storeOnboardingRequest.updateMany({
            where: { taskId: { in: dependencies.map(item => item.taskId) } },
            data: {
              status: StoreOnboardingStatus.blocked,
              currentStage: StoreOnboardingStage.blocked,
              lastError: recovered.lastError,
            },
          });
        }
      }
      return recovered;
    }
    const readyAt = brandTask?.status === TaskStatus.done
      ? brandTask.stepInstances.reduce<Date | null>((latest, step) => (
          step.completedAt && (!latest || step.completedAt > latest) ? step.completedAt : latest
        ), null) ?? brandTask.updatedAt
      : null;
    return tx.brandProvisioning.create({
      data: {
        brandId: input.brand!.id,
        sourceTaskId: brandTask?.id ?? null,
        status: !brandTask
          ? BrandProvisioningStatus.ready
          : brandTask.status === TaskStatus.done
            ? BrandProvisioningStatus.ready
            : brandTask.status === TaskStatus.failed
              ? BrandProvisioningStatus.failed
              : BrandProvisioningStatus.pending,
        autoCompleted: !brandTask,
        startedAt: brandTask?.createdAt ?? input.createdAt,
        readyAt: !brandTask ? input.createdAt : readyAt,
        failedAt: brandTask?.status === TaskStatus.failed ? brandTask.updatedAt : null,
        lastError: brandTask?.status === TaskStatus.failed ? 'Brand creation Task failed' : null,
      },
    });
  }

  private async reconcileBrandProvisioning(
    tx: StoreOnboardingTx,
    sourceTaskId: string,
    taskStatus: TaskStatus,
    control: { globalEnabled: boolean; notificationsEnabled: boolean },
  ) {
    const sourceTask = await tx.task.findUnique({
      where: { id: sourceTaskId },
      select: {
        id: true,
        brandId: true,
        taskTypeId: true,
        createdAt: true,
        updatedAt: true,
        stepInstances: { select: { completedAt: true } },
      },
    });
    let provisioning = await tx.brandProvisioning.findUnique({ where: { sourceTaskId } });
    if (!provisioning && sourceTask?.brandId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'store-onboarding-brand:' + sourceTask.brandId}))`;
      const retryable = await tx.brandProvisioning.findUnique({ where: { brandId: sourceTask.brandId } });
      if (
        retryable
        && (retryable.status === BrandProvisioningStatus.failed || retryable.status === BrandProvisioningStatus.cancelled)
        && sourceTask.createdAt > retryable.startedAt
      ) {
        const matchesFrozenRollout = await tx.storeOnboardingRequest.findFirst({
          where: {
            brandProvisioningId: retryable.id,
            rolloutRevision: { brandTaskTypeId: sourceTask.taskTypeId },
          },
          select: { id: true },
        });
        if (matchesFrozenRollout) {
          provisioning = await tx.brandProvisioning.update({
            where: { id: retryable.id },
            data: {
              sourceTaskId,
              status: BrandProvisioningStatus.pending,
              autoCompleted: false,
              startedAt: sourceTask.createdAt,
              readyAt: null,
              failedAt: null,
              lastError: 'Brand creation retry in progress',
            },
          });
          await tx.taskDependency.updateMany({
            where: {
              brandProvisioningId: retryable.id,
              status: { in: [TaskDependencyStatus.failed, TaskDependencyStatus.cancelled] },
            },
            data: {
              prerequisiteTaskId: sourceTaskId,
              status: TaskDependencyStatus.waiting,
              autoCompleted: false,
              startedAt: sourceTask.createdAt,
              satisfiedAt: null,
            },
          });
        }
      }
    }
    if (!provisioning || provisioning.status !== BrandProvisioningStatus.pending) return [] as string[];
    if (taskStatus !== TaskStatus.done && taskStatus !== TaskStatus.failed) return [] as string[];
    const now = taskStatus === TaskStatus.done
      ? sourceTask?.stepInstances.reduce<Date | null>((latest, step) => (
          step.completedAt && (!latest || step.completedAt > latest) ? step.completedAt : latest
        ), null) ?? sourceTask?.updatedAt ?? new Date()
      : sourceTask?.updatedAt ?? new Date();
    const ready = taskStatus === TaskStatus.done;
    await tx.brandProvisioning.update({
      where: { id: provisioning.id },
      data: ready
        ? { status: BrandProvisioningStatus.ready, readyAt: now, failedAt: null, lastError: null }
        : { status: BrandProvisioningStatus.failed, failedAt: now, lastError: 'Brand creation Task failed' },
    });
    const dependencies = await tx.taskDependency.findMany({
      where: { brandProvisioningId: provisioning.id, status: TaskDependencyStatus.waiting },
      select: { id: true, taskId: true },
    });
    if (dependencies.length) {
      await tx.taskDependency.updateMany({
        where: { id: { in: dependencies.map(item => item.id) }, status: TaskDependencyStatus.waiting },
        data: ready
          ? { status: TaskDependencyStatus.satisfied, satisfiedAt: now }
          : { status: TaskDependencyStatus.failed },
      });
    }
    if (!ready) {
      if (dependencies.length) {
        await tx.storeOnboardingRequest.updateMany({
          where: { taskId: { in: dependencies.map(item => item.taskId) } },
          data: {
            status: StoreOnboardingStatus.blocked,
            currentStage: StoreOnboardingStage.blocked,
            lastError: 'Brand creation Task failed',
          },
        });
        for (const dependency of dependencies) {
          await this.enqueueDomainEvent(tx, {
            eventKey: `brand-blocked:${provisioning.id}:${dependency.taskId}`,
            eventType: 'brand.blocked',
            aggregateType: 'brand_provisioning',
            aggregateId: provisioning.id,
            taskId: dependency.taskId,
            payload: { sourceTaskId, dependentTaskId: dependency.taskId, failedAt: now.toISOString() },
          }, control);
        }
      }
      return [] as string[];
    }
    const blockedTasks = await tx.task.findMany({
      where: { id: { in: dependencies.map(item => item.taskId) }, status: TaskStatus.blocked },
      select: { id: true, scheduledStart: true },
    });
    const readyNow: string[] = [];
    for (const task of blockedTasks) {
      const scheduled = !!task.scheduledStart && task.scheduledStart > now;
      await tx.task.update({
        where: { id: task.id },
        data: { status: scheduled ? TaskStatus.scheduled : TaskStatus.pending },
      });
      await tx.storeOnboardingRequest.updateMany({
        where: { taskId: task.id, currentStage: StoreOnboardingStage.blocked },
        data: { status: StoreOnboardingStatus.active, currentStage: StoreOnboardingStage.created, lastError: null },
      });
      if (!scheduled) readyNow.push(task.id);
      await this.enqueueDomainEvent(tx, {
        eventKey: `brand-ready:${provisioning.id}:${task.id}`,
        eventType: 'brand.ready',
        aggregateType: 'brand_provisioning',
        aggregateId: provisioning.id,
        taskId: task.id,
        payload: { sourceTaskId, dependentTaskId: task.id, readyAt: now.toISOString() },
      }, control);
    }
    return readyNow;
  }

  private async ensureRequestForTask(
    tx: StoreOnboardingTx,
    task: {
      id: string;
      status: TaskStatus;
      brandId: string | null;
      createdById: string;
      createdAt: Date;
      brand: { id: string; country: Country; kaType: KaType; ownerId: string | null } | null;
      taskShops: Array<{ shop: { id: string; shopId: string; appShopId: string } }>;
      stepInstances: Array<{ id: string; completedAt: Date | null }>;
      storeOnboardingEnrollment: {
        decision: StoreOnboardingEnrollmentDecision;
        source: StoreOnboardingSource;
        rolloutRevisionId: string | null;
        workflowVersion: string | null;
        countrySnapshot: Country | null;
        kaTypeSnapshot: KaType | null;
        eligibilitySnapshot: Prisma.JsonValue;
      } | null;
    },
    control: { globalEnabled: boolean; notificationsEnabled: boolean },
  ) {
    if (
      !task.brand
      || !task.storeOnboardingEnrollment?.rolloutRevisionId
      || !task.storeOnboardingEnrollment.workflowVersion
      || !task.storeOnboardingEnrollment.countrySnapshot
      || !task.storeOnboardingEnrollment.kaTypeSnapshot
    ) {
      throw new ConflictException('Enrolled Task is missing its immutable rollout snapshot');
    }
    const dependency = await tx.taskDependency.findFirst({
      where: { taskId: task.id, kind: 'brand_ready' },
      include: { brandProvisioning: true },
    });
    if (!dependency || dependency.status !== TaskDependencyStatus.satisfied) {
      throw new ConflictException('Brand prerequisite is not ready');
    }
    let request = await tx.storeOnboardingRequest.findUnique({ where: { taskId: task.id } });
    if (!request) {
      request = await tx.storeOnboardingRequest.create({
        data: {
          brandId: task.brand.id,
          taskId: task.id,
          source: task.storeOnboardingEnrollment.source,
          currentStage: StoreOnboardingStage.created,
          rolloutRevisionId: task.storeOnboardingEnrollment.rolloutRevisionId,
          workflowVersion: task.storeOnboardingEnrollment.workflowVersion,
          countrySnapshot: task.storeOnboardingEnrollment.countrySnapshot,
          kaTypeSnapshot: task.storeOnboardingEnrollment.kaTypeSnapshot,
          enrollmentSnapshot: task.storeOnboardingEnrollment.eligibilitySnapshot as Prisma.InputJsonValue,
          brandProvisioningId: dependency.brandProvisioningId,
          createdById: task.createdById,
          startedAt: task.createdAt,
        },
      });
    }
    const existingUnits = await tx.storeOnboardingUnit.count({ where: { requestId: request.id } });
    if (existingUnits > 0 || request.shopIdsValidatedAt) return request;
    const hasStructuredShops = task.taskShops.length > 0;
    const initialStage = !hasStructuredShops
      ? StoreOnboardingStage.awaiting_shop_ids
      : task.storeOnboardingEnrollment.kaTypeSnapshot === KaType.KA
        ? StoreOnboardingStage.awaiting_configuration_brief
        : StoreOnboardingStage.audit_preparing;
    const now = new Date();
    const finalCompletedStep = [...task.stepInstances].reverse().find(step => step.completedAt)?.id ?? null;
    await tx.storeOnboardingRequest.update({
      where: { id: request.id },
      data: {
        status: StoreOnboardingStatus.active,
        currentStage: initialStage,
        totalUnits: task.taskShops.length,
        completedUnits: 0,
        failedUnits: 0,
        shopIdsValidatedAt: hasStructuredShops ? now : null,
        shopIdsValidationSource: hasStructuredShops ? 'task_shop' : null,
        lastError: null,
      },
    });
    const batch = await tx.storeOnboardingBatch.upsert({
      where: { requestId_ordinal: { requestId: request.id, ordinal: 1 } },
      create: {
        requestId: request.id,
        ordinal: 1,
        label: 'Batch 1',
        sourceStepInstanceId: finalCompletedStep,
        brandProvisioningId: dependency.brandProvisioningId,
        startedAt: task.createdAt,
      },
      update: { sourceStepInstanceId: finalCompletedStep },
    });
    for (const item of task.taskShops) {
      await tx.storeOnboardingUnit.upsert({
        where: { requestId_externalShopId: { requestId: request.id, externalShopId: item.shop.shopId } },
        create: {
          requestId: request.id,
          batchId: batch.id,
          shopId: item.shop.id,
          externalShopId: item.shop.shopId,
          appShopId: item.shop.appShopId,
          stage: initialStage,
          configurationAssigneeId: task.brand.ownerId,
          goLiveAssigneeId: task.brand.ownerId,
          transitions: {
            create: {
              fromStage: StoreOnboardingStage.created,
              toStage: initialStage,
              metadata: { source: 'task_reconcile' },
            },
          },
        },
        update: {
          shopId: item.shop.id,
          appShopId: item.shop.appShopId,
        },
      });
    }
    await this.enqueueDomainEvent(tx, {
      eventKey: `stores-created:${request.id}`,
      eventType: 'stores.created',
      aggregateType: 'store_onboarding_request',
      aggregateId: request.id,
      requestId: request.id,
      taskId: task.id,
      actorId: task.createdById,
      payload: {
        requestId: request.id,
        taskId: task.id,
        source: request.source,
        country: request.countrySnapshot,
        kaType: request.kaTypeSnapshot,
        stage: initialStage,
        totalUnits: task.taskShops.length,
      },
    }, control);
    return tx.storeOnboardingRequest.findUniqueOrThrow({ where: { id: request.id } });
  }

  private dependencyStatus(status: BrandProvisioningStatus) {
    if (status === BrandProvisioningStatus.ready) return TaskDependencyStatus.satisfied;
    if (status === BrandProvisioningStatus.failed) return TaskDependencyStatus.failed;
    if (status === BrandProvisioningStatus.cancelled) return TaskDependencyStatus.cancelled;
    return TaskDependencyStatus.waiting;
  }
}
