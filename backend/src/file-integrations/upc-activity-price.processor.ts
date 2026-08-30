import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import {
  downloadMenu,
  MenuDownloadProgress,
  MenuExportTaskFailedError,
} from '../integrations/auto-turn-off-api.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  catalogMutationResourceKey,
  OperationalLeaseExclusiveContext,
  OperationalLeaseLostError,
  OperationalLeaseService,
  OperationalLeaseUnavailableError,
  upcExecutionResourceKey,
} from '../prisma/operational-lease.service';
import { getAuthToken, parseJsonKeepingIds, sleep } from '../queue/handlers/didi-food.util';
import {
  checkGroceryUploadTaskOnce,
  GroceryItemFailure,
  submitGroceryBatch,
} from './grocery-menu-upload.util';
import {
  buildActivityPriceMenuUpload,
  prepareActivityPriceUpdates,
  shouldRetryActivityPriceUpload,
  verifyActivityPriceUpdates,
} from './upc-activity-price.util';

const MAX_EXPORT_ATTEMPTS = 3;
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_TASK_POLL_MS = 10_000;
const MAX_AUDITED_FAILURES = 25;

class UpcActivityPriceCancelledError extends Error {}
class UpcActivityPriceSubmissionAmbiguousError extends Error {}

type ShopOutcome = 'updated' | 'partial_success' | 'would_update' | 'already_current' | 'upc_not_found' | 'failed';

interface UploadAttemptAudit {
  attempt: number;
  submittedItemIds: string[];
  taskId?: string;
  submissionState: 'prepared' | 'submitting' | 'submitted' | 'terminal' | 'verified' | 'unconfirmed';
  taskStatus?: number;
  polls: number;
  failures: GroceryItemFailure[];
  verificationTaskIds: string[];
  confirmedItemIds: string[];
  remainingItemIds: string[];
  missingItemIds: string[];
  error?: string;
}

interface UploadLifecycleResult {
  confirmedItemIds: string[];
  remainingItemIds: string[];
  missingItemIds: string[];
  lastTaskStatus?: number;
}

interface ShopResult {
  shopId: string;
  appShopId?: string;
  outcome: ShopOutcome;
  matchedItems: number;
  changedItems: number;
  exportTaskId?: string;
  exportTaskIds?: string[];
  verificationTaskIds?: string[];
  uploadReferenceId?: string;
  uploadTaskIds?: string[];
  uploadAttempts?: UploadAttemptAudit[];
  error?: string;
}

interface ActiveShopProgress {
  shopId: string;
  appShopId: string;
  phase: 'exporting_menu' | 'matching_upc' | 'submitting_upload' | 'polling_upload' | 'verifying_items' | 'retry_wait';
  message: string;
  matchedItems: number;
  expectedChanges: number;
  exportTaskIds: string[];
  verificationTaskIds: string[];
  uploadTaskIds: string[];
  uploadAttempts: UploadAttemptAudit[];
  expectedItemIds: string[];
  currentTaskId?: string;
  currentTaskStatus?: number;
  currentTaskPolls?: number;
}

@Injectable()
@Processor('upc-activity-price', { concurrency: 1 })
export class UpcActivityPriceProcessor extends WorkerHost {
  private readonly logger = new Logger(UpcActivityPriceProcessor.name);
  private readonly executionLeases = new Map<string, OperationalLeaseExclusiveContext>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly leases: OperationalLeaseService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    try {
      await this.leases.runExclusive({
        resourceKey: upcExecutionResourceKey(executionId),
        ownerKind: 'upc-activity-price-worker',
        ownerId: `${executionId}:${String(job.id ?? 'unknown')}:${job.attemptsMade}`,
        ttlMs: 5 * 60_000,
        heartbeatIntervalMs: 30_000,
        wait: false,
      }, async executionLease => {
        this.executionLeases.set(executionId, executionLease);
        try {
          await this.processOwned(job);
        } finally {
          this.executionLeases.delete(executionId);
        }
      });
    } catch (error) {
      if (error instanceof OperationalLeaseUnavailableError) {
        this.logger.warn(`Skipped duplicate UPC worker delivery for ${executionId}; another fenced worker owns it`);
        return;
      }
      if (error instanceof OperationalLeaseLostError) {
        this.logger.warn(`UPC worker ${executionId} lost its DB lease; a recovery worker will continue`);
        return;
      }
      throw error;
    }
  }

  private async processOwned(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.updateMany({
      where: {
        id: executionId,
        status: { in: ['pending', 'running'] },
        manualReviewRequired: false,
      },
      data: { status: 'running' },
    }));
    if (!claimed.count) return;

    const execution = await this.prisma.upcActivityPriceExecution.findUnique({
      where: { id: executionId },
      include: { rule: { include: { application: true } } },
    });
    if (!execution) return;
    const started = execution.startedAt?.getTime() ?? Date.now();
    if (!execution.startedAt) {
      await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.update({
        where: { id: executionId },
        data: { startedAt: new Date(started), errorMessage: null },
      }));
    }
    const { rule } = execution;
    const restored = this.restoreProgress(execution.result);
    const results = restored.results;
    const activeShops = restored.activeShops;

    try {
      this.assertRemoteWriteGate(execution.dryRun);
      const encryptionKey = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      const appSecret = decrypt(rule.application.appSecret, encryptionKey);
      const completedShopIds = new Set(results.map(value => value.shopId));
      const targets = (await this.resolveTargets(rule.applicationId, rule.shopIds))
        .filter(value => !completedShopIds.has(value.shopId));
      // A live execution is deliberately serialized. Its JSON checkpoint is the
      // durable source of truth for remote task IDs, so concurrent whole-object
      // writes must never be able to overwrite one another.
      await this.mapWithConcurrency(targets, 1, async target => {
        await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.update({
          where: { id: executionId },
          data: { currentShopId: target.shopId },
        }));
        const progress: ActiveShopProgress = activeShops.get(target.shopId) ?? {
          shopId: target.shopId,
          appShopId: target.appShopId,
          phase: 'exporting_menu',
          message: 'Requesting and monitoring the menu export task',
          matchedItems: 0,
          expectedChanges: 0,
          exportTaskIds: [],
          verificationTaskIds: [],
          uploadTaskIds: [],
          uploadAttempts: [],
          expectedItemIds: [],
        };
        activeShops.set(target.shopId, progress);
        const freshToken = () => getAuthToken(rule.application.appId, appSecret, progress.appShopId);
        let preserveProgress = false;
        const runTarget = async (catalogLease?: OperationalLeaseExclusiveContext) => {
          const ensureTargetActive = async () => {
            await this.ensureCanSubmit(executionId);
            if (catalogLease) await catalogLease.ensureActive();
          };
          try {
          const restoredExpectedItemIds = this.expectedItemIds(progress);
          if (!execution.dryRun && progress.uploadAttempts.length && restoredExpectedItemIds.length) {
            progress.expectedItemIds = restoredExpectedItemIds;
            const lifecycle = await this.runUploadLifecycle({
              executionId,
              applicationId: rule.application.appId,
              targetUpc: rule.targetUpc,
              expectedItemIds: restoredExpectedItemIds,
              freshToken,
              progress,
              ensureCatalogActive: catalogLease
                ? () => catalogLease.ensureActive().then(() => undefined)
                : undefined,
              persist: () => this.saveProgress(executionId, results, activeShops),
            });
            results.push(this.buildLiveResult({
              shopId: target.shopId,
              appShopId: target.appShopId,
              matchedItems: progress.matchedItems,
              exportTaskId: progress.exportTaskIds.at(-1),
              exportTaskIds: [...progress.exportTaskIds],
            }, progress, lifecycle));
          } else {
            await ensureTargetActive();
            const downloaded = await this.downloadMenuWithRetries(
              freshToken,
              ensureTargetActive,
              rule.application.appId,
              async value => {
                progress.phase = 'exporting_menu';
                progress.message = this.menuProgressMessage(value.progress, value.exportAttempt, false);
                this.addUnique(progress.exportTaskIds, value.progress.taskId);
                this.setTaskProgress(progress, value.progress.taskId, value.progress.status, value.progress.pollAttempts);
                await this.saveProgress(executionId, results, activeShops);
              },
              progress.phase === 'exporting_menu' ? progress.exportTaskIds.at(-1) : undefined,
            );
            const latestMenu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
            const prepared = prepareActivityPriceUpdates(latestMenu, rule.targetUpc);
            progress.phase = 'matching_upc';
            progress.message = `Matched ${prepared.matches.length} item(s); ${prepared.updates.length} require a change`;
            progress.matchedItems = prepared.matches.length;
            progress.expectedChanges = prepared.updates.length;
            progress.expectedItemIds = prepared.updates.map(item => String(item.app_item_id));
            await this.saveProgress(executionId, results, activeShops);

            const common = {
              shopId: target.shopId,
              appShopId: target.appShopId,
              matchedItems: prepared.matches.length,
              exportTaskId: downloaded.taskId,
              exportTaskIds: [...progress.exportTaskIds],
            };
            if (!prepared.matches.length) {
              results.push({ ...common, outcome: 'upc_not_found', changedItems: 0 });
            } else if (!prepared.updates.length) {
              results.push({ ...common, outcome: 'already_current', changedItems: 0 });
            } else if (execution.dryRun) {
              results.push({ ...common, outcome: 'would_update', changedItems: prepared.updates.length });
            } else {
              const lifecycle = await this.runUploadLifecycle({
                executionId,
                applicationId: rule.application.appId,
                targetUpc: rule.targetUpc,
                expectedItemIds: progress.expectedItemIds,
                latestMenu,
                freshToken,
                progress,
                ensureCatalogActive: catalogLease
                  ? () => catalogLease.ensureActive().then(() => undefined)
                  : undefined,
                persist: () => this.saveProgress(executionId, results, activeShops),
              });
              results.push(this.buildLiveResult(common, progress, lifecycle));
            }
          }
          } catch (error) {
          if (error instanceof UpcActivityPriceCancelledError) throw error;
          if (error instanceof OperationalLeaseLostError) {
            preserveProgress = true;
            progress.message = this.safeError(error);
            await this.saveProgress(executionId, results, activeShops);
            throw error;
          }
          if (error instanceof UpcActivityPriceSubmissionAmbiguousError || this.hasRecoverableRemoteWork(progress)) {
            preserveProgress = true;
            progress.message = this.safeError(error);
            await this.saveProgress(executionId, results, activeShops);
            throw error;
          }
          results.push({
            shopId: target.shopId,
            appShopId: target.appShopId,
            outcome: 'failed',
            matchedItems: progress.matchedItems,
            changedItems: 0,
            exportTaskId: progress.exportTaskIds.at(-1),
            exportTaskIds: [...progress.exportTaskIds],
            verificationTaskIds: [...progress.verificationTaskIds],
            uploadReferenceId: progress.uploadTaskIds.at(-1),
            uploadTaskIds: [...progress.uploadTaskIds],
            uploadAttempts: progress.uploadAttempts,
            error: this.safeError(error),
          });
          } finally {
          if (!preserveProgress) activeShops.delete(target.shopId);
          }
          await this.saveProgress(executionId, results, activeShops);
        };

        if (execution.dryRun) {
          await runTarget();
          return;
        }
        this.assertLiveShopAllowed(target.appShopId);
        await this.leases.runExclusive({
          resourceKey: catalogMutationResourceKey(rule.applicationId, target.appShopId),
          ownerKind: 'upc-activity-price',
          ownerId: `${executionId}:${target.appShopId}`,
          ttlMs: 5 * 60_000,
          heartbeatIntervalMs: 30_000,
          wait: true,
          waitTimeoutMs: 15 * 60_000,
          retryDelayMs: 1_000,
          ensureActive: async () => {
            await this.ensureCanSubmit(executionId);
          },
        }, runTarget);
      });

      if (await this.isCancellationRequested(executionId)) {
        await this.finishCancelled(executionId, results, started);
        return;
      }
      await this.ensureCanSubmit(executionId);
      const successfulShops = results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length;
      const skippedShops = results.filter(value => value.outcome === 'upc_not_found').length;
      const failedShops = results.filter(value => value.outcome === 'failed').length;
      const partialShops = results.filter(value => value.outcome === 'partial_success').length;
      const status: AutoOpenStatus = successfulShops === 0
        ? AutoOpenStatus.failed
        : failedShops || skippedShops || partialShops
          ? AutoOpenStatus.partial_success : AutoOpenStatus.done;
      const now = new Date();
      const errorMessage = status === AutoOpenStatus.done
        ? null
        : `${failedShops} store(s) failed; ${partialShops} store(s) were partially updated; ${skippedShops} store(s) did not contain UPC ${rule.targetUpc}`;
      await this.withExecutionFence(executionId, async tx => {
        await tx.upcActivityPriceExecution.update({
          where: { id: executionId },
          data: {
            status,
            finishedAt: now,
            durationMs: Date.now() - started,
            currentShopId: null,
            processedShops: results.length,
            successfulShops,
            skippedShops,
            failedShops,
            manualReviewRequired: false,
            manualReviewReason: null,
            errorMessage,
            result: { targetUpc: rule.targetUpc, dryRun: execution.dryRun, shops: results } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.upcActivityPriceRule.update({ where: { id: rule.id }, data: { lastRunAt: now } });
      });
      this.logger.log(`UPC activity-price ${rule.name}: ${status}; ${successfulShops}/${results.length}; dryRun=${execution.dryRun}`);
    } catch (error) {
      if (error instanceof UpcActivityPriceCancelledError) {
        await this.finishCancelled(executionId, results, started);
        return;
      }
      if (error instanceof UpcActivityPriceSubmissionAmbiguousError) {
        await this.blockForManualReview(executionId, this.safeError(error), results, activeShops);
        return;
      }
      if (error instanceof OperationalLeaseLostError
        && error.resourceKey === upcExecutionResourceKey(executionId)) {
        throw error;
      }
      if (error instanceof OperationalLeaseUnavailableError
        || error instanceof OperationalLeaseLostError) {
        await this.markRecoveryPending(executionId, this.safeError(error), results, activeShops);
        throw error;
      }
      if ([...activeShops.values()].some(progress => this.hasRecoverableRemoteWork(progress))) {
        await this.markRecoveryPending(executionId, this.safeError(error), results, activeShops);
        throw error;
      }
      await this.fail(executionId, this.safeError(error), results, started);
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    // Bull failed events are diagnostic only. A delayed event may belong to a
    // stale worker after a newer fenced owner has already resumed the same
    // execution. All durable transitions happen inside processOwned while the
    // DB lease is held.
    this.logger.error(
      `UPC Bull job ${job?.id ?? 'unknown'} failed; fenced recovery will reconcile it: ${this.safeError(error)}`,
    );
  }

  private assertRemoteWriteGate(dryRun: boolean, appShopId?: string) {
    const enabled = this.config.get('UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED', 'false').trim().toLowerCase() === 'true';
    if (!dryRun && !enabled) {
      throw new Error(
        'Live UPC activity-price writes are disabled by the server safety gate; '
        + 'keep them disabled until exclusive per-store menu-write coordination and worker ownership are approved',
      );
    }
    if (!dryRun && appShopId) this.assertLiveShopAllowed(appShopId);
  }

  private assertLiveShopAllowed(appShopId: string) {
    const allowed = new Set(
      this.config.get<string>('UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST', '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    );
    if (!allowed.has(appShopId.trim())) {
      throw new Error(
        `Live UPC activity-price is not allowlisted for app_shop_id ${appShopId}; `
        + 'add exactly the reviewed pilot store before enabling remote writes',
      );
    }
  }

  private restoreProgress(value: Prisma.JsonValue | null): {
    results: ShopResult[];
    activeShops: Map<string, ActiveShopProgress>;
  } {
    const root = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const outcomes = new Set<ShopOutcome>([
      'updated', 'partial_success', 'would_update', 'already_current', 'upc_not_found', 'failed',
    ]);
    const phases = new Set<ActiveShopProgress['phase']>([
      'exporting_menu', 'matching_upc', 'submitting_upload', 'polling_upload', 'verifying_items', 'retry_wait',
    ]);
    const strings = (input: unknown) => Array.isArray(input)
      ? [...new Set(input.map(item => String(item ?? '').trim()).filter(Boolean))]
      : [];
    const number = (input: unknown, fallback = 0) => Number.isFinite(Number(input)) ? Number(input) : fallback;
    const attempts = (input: unknown): UploadAttemptAudit[] => Array.isArray(input)
      ? input.flatMap((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const raw = entry as Record<string, unknown>;
        const taskId = String(raw.taskId ?? '').trim() || undefined;
        const taskStatus = Number.isFinite(Number(raw.taskStatus)) ? Number(raw.taskStatus) : undefined;
        const confirmedItemIds = strings(raw.confirmedItemIds);
        const remainingItemIds = strings(raw.remainingItemIds);
        const missingItemIds = strings(raw.missingItemIds);
        const explicitState = String(raw.submissionState ?? '');
        const allowedStates: UploadAttemptAudit['submissionState'][] = [
          'prepared', 'submitting', 'submitted', 'terminal', 'verified', 'unconfirmed',
        ];
        const submissionState: UploadAttemptAudit['submissionState'] = allowedStates.includes(
          explicitState as UploadAttemptAudit['submissionState'],
        )
          ? explicitState as UploadAttemptAudit['submissionState']
          : !taskId
            ? 'prepared'
            : [1, 2, 5].includes(taskStatus ?? -1)
              ? confirmedItemIds.length || remainingItemIds.length || missingItemIds.length ? 'verified' : 'terminal'
              : 'submitted';
        const failures: GroceryItemFailure[] = Array.isArray(raw.failures)
          ? raw.failures.flatMap(failure => {
            if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return [];
            const item = failure as Record<string, unknown>;
            return [{
              appItemId: String(item.appItemId ?? 'unknown'),
              reason: String(item.reason ?? 'Unknown task failure'),
            }];
          }).slice(0, MAX_AUDITED_FAILURES)
          : [];
        return [{
          attempt: Math.max(1, number(raw.attempt, index + 1)),
          submittedItemIds: strings(raw.submittedItemIds),
          taskId,
          submissionState,
          taskStatus,
          polls: Math.max(0, number(raw.polls)),
          failures,
          verificationTaskIds: strings(raw.verificationTaskIds),
          confirmedItemIds,
          remainingItemIds,
          missingItemIds,
          error: raw.error ? String(raw.error) : undefined,
        }];
      })
      : [];

    const results: ShopResult[] = Array.isArray(root.shops)
      ? root.shops.flatMap(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const raw = entry as Record<string, unknown>;
        const shopId = String(raw.shopId ?? '').trim();
        const outcome = String(raw.outcome ?? '') as ShopOutcome;
        if (!shopId || !outcomes.has(outcome)) return [];
        return [{
          shopId,
          appShopId: raw.appShopId ? String(raw.appShopId) : undefined,
          outcome,
          matchedItems: number(raw.matchedItems),
          changedItems: number(raw.changedItems),
          exportTaskId: raw.exportTaskId ? String(raw.exportTaskId) : undefined,
          exportTaskIds: strings(raw.exportTaskIds),
          verificationTaskIds: strings(raw.verificationTaskIds),
          uploadReferenceId: raw.uploadReferenceId ? String(raw.uploadReferenceId) : undefined,
          uploadTaskIds: strings(raw.uploadTaskIds),
          uploadAttempts: attempts(raw.uploadAttempts),
          error: raw.error ? String(raw.error) : undefined,
        }];
      })
      : [];

    const activeShops = new Map<string, ActiveShopProgress>();
    if (Array.isArray(root.activeShops)) {
      for (const entry of root.activeShops) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const raw = entry as Record<string, unknown>;
        const shopId = String(raw.shopId ?? '').trim();
        const appShopId = String(raw.appShopId ?? '').trim();
        if (!shopId || !appShopId) continue;
        const uploadAttempts = attempts(raw.uploadAttempts);
        const phaseValue = String(raw.phase ?? '') as ActiveShopProgress['phase'];
        const progress: ActiveShopProgress = {
          shopId,
          appShopId,
          phase: phases.has(phaseValue) ? phaseValue : 'exporting_menu',
          message: String(raw.message ?? 'Recovering persisted task checkpoint'),
          matchedItems: number(raw.matchedItems),
          expectedChanges: number(raw.expectedChanges),
          exportTaskIds: strings(raw.exportTaskIds),
          verificationTaskIds: strings(raw.verificationTaskIds),
          uploadTaskIds: strings(raw.uploadTaskIds),
          uploadAttempts,
          expectedItemIds: strings(raw.expectedItemIds).length
            ? strings(raw.expectedItemIds)
            : [...new Set(uploadAttempts.flatMap(attempt => attempt.submittedItemIds))],
          currentTaskId: raw.currentTaskId ? String(raw.currentTaskId) : undefined,
          currentTaskStatus: Number.isFinite(Number(raw.currentTaskStatus)) ? Number(raw.currentTaskStatus) : undefined,
          currentTaskPolls: Number.isFinite(Number(raw.currentTaskPolls)) ? Number(raw.currentTaskPolls) : undefined,
        };
        activeShops.set(shopId, progress);
      }
    }
    return { results, activeShops };
  }

  private async runUploadLifecycle(input: {
    executionId: string;
    applicationId: string;
    targetUpc: string;
    expectedItemIds: string[];
    latestMenu?: Record<string, unknown>;
    freshToken: () => Promise<string>;
    progress: ActiveShopProgress;
    ensureCatalogActive?: () => Promise<void>;
    persist: () => Promise<void>;
  }): Promise<UploadLifecycleResult> {
    const expectedItemIds = [...new Set(input.expectedItemIds.map(String).filter(Boolean))];
    input.progress.expectedItemIds = expectedItemIds;
    let latestMenu = input.latestMenu;
    let lastTaskStatus: number | undefined;
    const ensureLifecycleActive = async (monitorOnly = false) => {
      if (monitorOnly) await this.ensureMonitorable(input.executionId);
      else await this.ensureCanSubmit(input.executionId);
      if (input.ensureCatalogActive) await input.ensureCatalogActive();
    };

    const verificationTruth = () => {
      const last = input.progress.uploadAttempts.at(-1);
      const confirmed = new Set((last?.confirmedItemIds ?? []).filter(id => expectedItemIds.includes(id)));
      const missing = (last?.missingItemIds ?? []).filter(id => expectedItemIds.includes(id));
      const remaining = expectedItemIds.filter(id => !confirmed.has(id));
      return { confirmedItemIds: [...confirmed], remainingItemIds: remaining, missingItemIds: missing };
    };

    const downloadLatestMenu = async (attempt: UploadAttemptAudit | undefined, resumeKnownTask: boolean) => {
      await ensureLifecycleActive();
      const downloaded = await this.downloadMenuWithRetries(
        input.freshToken,
        () => ensureLifecycleActive(),
        input.applicationId,
        async value => {
          input.progress.phase = 'verifying_items';
          input.progress.message = this.menuProgressMessage(value.progress, value.exportAttempt, true);
          this.addUnique(input.progress.verificationTaskIds, value.progress.taskId);
          if (attempt) this.addUnique(attempt.verificationTaskIds, value.progress.taskId);
          this.setTaskProgress(
            input.progress,
            value.progress.taskId,
            value.progress.status,
            value.progress.pollAttempts,
          );
          await input.persist();
        },
        resumeKnownTask ? attempt?.verificationTaskIds.at(-1) : undefined,
      );
      latestMenu = parseJsonKeepingIds(downloaded.rawJson) as Record<string, unknown>;
      return latestMenu;
    };

    const verifyLatestMenu = async (attempt: UploadAttemptAudit, resumeKnownTask: boolean) => {
      const menu = await downloadLatestMenu(attempt, resumeKnownTask);
      const verification = verifyActivityPriceUpdates(menu, input.targetUpc, expectedItemIds);
      attempt.confirmedItemIds = verification.confirmedIds;
      attempt.remainingItemIds = verification.pendingUpdates.map(item => String(item.app_item_id));
      attempt.missingItemIds = verification.missingIds;
      attempt.submissionState = 'verified';
      input.progress.phase = 'verifying_items';
      input.progress.message = verification.confirmedIds.length === expectedItemIds.length
        ? `Verified all ${expectedItemIds.length} target item(s)`
        : `Verified ${verification.confirmedIds.length}/${expectedItemIds.length}; ${verification.pendingUpdates.length} retryable`;
      await this.persistUntilSaved(input.persist, 'verification checkpoint');
      return verification;
    };

    while (true) {
      let attempt = input.progress.uploadAttempts.at(-1);
      if (attempt?.submissionState === 'unconfirmed'
        || (attempt?.submissionState === 'submitting' && !attempt.taskId)) {
        throw new UpcActivityPriceSubmissionAmbiguousError(
          `Upload attempt ${attempt.attempt} for shop ${input.progress.shopId} may have reached DiDi without a persisted taskID; automatic resubmission is blocked`,
        );
      }

      if (attempt?.submissionState === 'submitted') {
        if (!attempt.taskId) {
          attempt.submissionState = 'unconfirmed';
          await this.persistUntilSaved(input.persist, 'ambiguous upload checkpoint');
          throw new UpcActivityPriceSubmissionAmbiguousError(
            `Upload attempt ${attempt.attempt} has no taskID; automatic resubmission is blocked`,
          );
        }
        input.progress.phase = 'polling_upload';
        input.progress.message = `Polling accepted upload task ${attempt.taskId} until terminal status`;
        const authToken = await input.freshToken();
        const terminal = await this.pollUploadTask(
          authToken,
          attempt.taskId,
          input.freshToken,
          () => ensureLifecycleActive(true),
          input.applicationId,
          async value => {
            attempt!.polls = value.polls;
            if (value.status !== undefined) attempt!.taskStatus = value.status;
            this.setTaskProgress(input.progress, attempt!.taskId!, value.status, value.polls);
            input.progress.message = value.rateLimited
              ? `Waiting for shared task-status window for upload ${attempt!.taskId}`
              : `Polling upload ${attempt!.taskId}; last status ${value.status ?? 'unknown'}`;
            await input.persist();
          },
        );
        attempt.taskStatus = terminal.status;
        attempt.polls = terminal.polls;
        attempt.failures = terminal.failedItems.slice(0, MAX_AUDITED_FAILURES);
        attempt.submissionState = 'terminal';
        lastTaskStatus = terminal.status;
        input.progress.currentTaskStatus = terminal.status;
        input.progress.message = `Upload task ${attempt.taskId} reached terminal status ${terminal.status}`;
        await this.persistUntilSaved(input.persist, 'terminal upload checkpoint');
      }

      attempt = input.progress.uploadAttempts.at(-1);
      if (attempt?.submissionState === 'terminal') {
        lastTaskStatus = attempt.taskStatus;
        if (await this.isCancellationRequested(input.executionId)) return { ...verificationTruth(), lastTaskStatus };
        await verifyLatestMenu(
          attempt,
          input.progress.phase === 'verifying_items' && Boolean(attempt.verificationTaskIds.at(-1)),
        );
      }

      attempt = input.progress.uploadAttempts.at(-1);
      if (attempt?.submissionState === 'verified') {
        lastTaskStatus = attempt.taskStatus;
        let truth = verificationTruth();
        if (!truth.remainingItemIds.length || await this.isCancellationRequested(input.executionId)) {
          return { ...truth, lastTaskStatus };
        }
        if (!shouldRetryActivityPriceUpload({
          taskStatus: attempt.taskStatus ?? -1,
          confirmedCount: truth.confirmedItemIds.length,
          expectedCount: expectedItemIds.length,
          pendingUpdateCount: attempt.remainingItemIds.length,
          attempt: attempt.attempt,
          maxAttempts: MAX_UPLOAD_ATTEMPTS,
        })) return { ...truth, lastTaskStatus };

        if (!latestMenu) {
          const verification = await verifyLatestMenu(attempt, false);
          truth = verificationTruth();
          if (!truth.remainingItemIds.length) return { ...truth, lastTaskStatus };
          if (!verification.pendingUpdates.length) return { ...truth, lastTaskStatus };
        }
        input.progress.phase = 'retry_wait';
        input.progress.message = `Retrying ${attempt.remainingItemIds.length} unconfirmed item(s) after terminal task ${attempt.taskId}`;
        await input.persist();
        await sleep(attempt.attempt * 5_000);
        attempt = undefined;
      }

      const truth = verificationTruth();
      const retryIds = input.progress.uploadAttempts.length
        ? input.progress.uploadAttempts.at(-1)?.remainingItemIds ?? []
        : truth.remainingItemIds;
      if (!retryIds.length) return { ...truth, lastTaskStatus };
      if (!latestMenu) {
        const previous = input.progress.uploadAttempts.at(-1);
        if (previous?.submissionState === 'prepared') {
          latestMenu = await downloadLatestMenu(previous, false);
        } else if (previous?.submissionState === 'verified') {
          const verification = await verifyLatestMenu(previous, false);
          if (!verification.pendingUpdates.length) return { ...verificationTruth(), lastTaskStatus };
        } else {
          latestMenu = await downloadLatestMenu(previous, false);
        }
      }
      if (!latestMenu) throw new Error('A fresh exported menu is required before uploadGrocery');
      const built = buildActivityPriceMenuUpload(latestMenu, input.targetUpc, retryIds);
      const submittedItemIds = built.updates.map(item => String(item.app_item_id));
      if (!submittedItemIds.length) return { ...verificationTruth(), lastTaskStatus };
      await ensureLifecycleActive();
      this.assertRemoteWriteGate(false, input.progress.appShopId);

      attempt = input.progress.uploadAttempts.at(-1);
      if (attempt?.submissionState !== 'prepared') {
        attempt = {
          attempt: input.progress.uploadAttempts.length + 1,
          submittedItemIds,
          submissionState: 'prepared',
          polls: 0,
          failures: [],
          verificationTaskIds: [],
          confirmedItemIds: truth.confirmedItemIds,
          remainingItemIds: submittedItemIds,
          missingItemIds: truth.missingItemIds,
        };
        input.progress.uploadAttempts.push(attempt);
      } else {
        attempt.submittedItemIds = submittedItemIds;
        attempt.remainingItemIds = submittedItemIds;
      }
      input.progress.phase = 'submitting_upload';
      input.progress.message = `Prepared upload attempt ${attempt.attempt}/${MAX_UPLOAD_ATTEMPTS}`;
      await this.persistUntilSaved(input.persist, 'prepared upload checkpoint');

      const authToken = await input.freshToken();
      await ensureLifecycleActive();
      attempt.submissionState = 'submitting';
      input.progress.message = `Submitting upload attempt ${attempt.attempt}/${MAX_UPLOAD_ATTEMPTS}`;
      await this.persistUntilSaved(input.persist, 'pre-submission checkpoint');
      try {
        await ensureLifecycleActive();
      } catch (error) {
        // The POST has not been called yet, so this boundary is safe to resume.
        attempt.submissionState = 'prepared';
        await this.persistUntilSaved(input.persist, 'cancelled pre-submission checkpoint');
        throw error;
      }

      try {
        const submission = await submitGroceryBatch(authToken, built.upload, 'uploadGrocery', 0);
        if ('acceptedCount' in submission || !submission.referenceId) {
          throw new Error('uploadGrocery did not return an asynchronous taskID');
        }
        attempt.taskId = submission.referenceId;
        attempt.submissionState = 'submitted';
        this.addUnique(input.progress.uploadTaskIds, submission.referenceId);
        input.progress.currentTaskId = submission.referenceId;
        input.progress.currentTaskStatus = undefined;
        input.progress.currentTaskPolls = 0;
        input.progress.message = `Accepted upload task ${submission.referenceId}; persisting before polling`;
        await this.persistUntilSaved(input.persist, 'accepted upload taskID');
      } catch (error) {
        attempt.submissionState = 'unconfirmed';
        attempt.error = this.safeError(error);
        input.progress.message = 'uploadGrocery acceptance is ambiguous; automatic resubmission is blocked';
        await this.persistUntilSaved(input.persist, 'ambiguous upload checkpoint');
        throw new UpcActivityPriceSubmissionAmbiguousError(
          `uploadGrocery attempt ${attempt.attempt} has an unknown acceptance result: ${this.safeError(error)}`,
        );
      }
      latestMenu = undefined;
    }
  }

  private buildLiveResult(
    common: Pick<ShopResult, 'shopId' | 'appShopId' | 'matchedItems' | 'exportTaskId' | 'exportTaskIds'>,
    progress: ActiveShopProgress,
    lifecycle: UploadLifecycleResult,
  ): ShopResult {
    const allConfirmed = lifecycle.remainingItemIds.length === 0 && lifecycle.missingItemIds.length === 0;
    const outcome: ShopOutcome = allConfirmed && lifecycle.lastTaskStatus === 1
      ? 'updated'
      : lifecycle.confirmedItemIds.length ? 'partial_success' : 'failed';
    const failureDetails = progress.uploadAttempts
      .flatMap(attempt => attempt.failures)
      .slice(0, MAX_AUDITED_FAILURES)
      .map(item => `${item.appItemId}: ${item.reason}`);
    const issues = [
      ...failureDetails,
      lifecycle.remainingItemIds.length ? `unconfirmed item IDs: ${lifecycle.remainingItemIds.join(', ')}` : '',
      lifecycle.missingItemIds.length ? `missing/changed item IDs: ${lifecycle.missingItemIds.join(', ')}` : '',
      lifecycle.lastTaskStatus !== undefined && lifecycle.lastTaskStatus !== 1
        ? `last upload task status: ${lifecycle.lastTaskStatus}` : '',
    ].filter(Boolean);
    return {
      ...common,
      outcome,
      changedItems: lifecycle.confirmedItemIds.length,
      exportTaskIds: [...progress.exportTaskIds],
      verificationTaskIds: [...progress.verificationTaskIds],
      uploadReferenceId: progress.uploadTaskIds.at(-1),
      uploadTaskIds: [...progress.uploadTaskIds],
      uploadAttempts: progress.uploadAttempts,
      error: issues.length ? issues.join('; ').slice(0, 1200) : undefined,
    };
  }

  private expectedItemIds(progress: ActiveShopProgress) {
    return [...new Set([
      ...progress.expectedItemIds,
      ...progress.uploadAttempts.flatMap(attempt => attempt.submittedItemIds),
    ].filter(Boolean))];
  }

  private hasRecoverableRemoteWork(progress: ActiveShopProgress) {
    const last = progress.uploadAttempts.at(-1);
    if (!last) {
      return (progress.phase === 'exporting_menu' && progress.exportTaskIds.length > 0)
        || (progress.phase === 'verifying_items' && progress.verificationTaskIds.length > 0);
    }
    if (['submitting', 'submitted', 'terminal', 'unconfirmed'].includes(last.submissionState)) return true;
    return last.submissionState === 'prepared' || (last.submissionState === 'verified' && last.remainingItemIds.length > 0);
  }

  private async persistUntilSaved(persist: () => Promise<void>, label: string) {
    let failures = 0;
    while (true) {
      try {
        await persist();
        return;
      } catch (error) {
        if (error instanceof OperationalLeaseLostError) throw error;
        failures += 1;
        if (failures === 1 || failures % 12 === 0) {
          this.logger.error(`Could not persist ${label}; retrying without resubmission: ${this.safeError(error)}`);
        }
        await sleep(5_000);
      }
    }
  }

  private async downloadMenuWithRetries(
    getToken: () => Promise<string>,
    ensureActive: () => Promise<void>,
    rateLimitKey: string,
    onProgress: (value: { exportAttempt: number; progress: MenuDownloadProgress }) => Promise<void>,
    existingTaskId?: string,
  ) {
    let taskIdToResume = existingTaskId;
    let lastPhase: MenuDownloadProgress['phase'] | undefined;
    let exportAttempt = 1;
    while (exportAttempt <= MAX_EXPORT_ATTEMPTS) {
      await ensureActive();
      const authToken = await getToken();
      try {
        return await downloadMenu(authToken, ensureActive, getToken, {
          existingTaskId: taskIdToResume,
          rateLimitKey,
          timeoutMs: null,
          onProgress: async progress => {
            // Once DiDi returns an export taskID, keep it authoritative across
            // transient lookup failures. A replacement export is allowed only
            // after that task explicitly reaches terminal failure.
            taskIdToResume = progress.taskId;
            lastPhase = progress.phase;
            await onProgress({ exportAttempt, progress });
          },
        });
      } catch (error) {
        if (error instanceof MenuExportTaskFailedError) {
          // Start another export only after DiDi explicitly terminalized the
          // prior task as failed. Terminal failures consume the bounded retry.
          if (exportAttempt === MAX_EXPORT_ATTEMPTS) throw error;
          taskIdToResume = undefined;
          await ensureActive();
          await sleep(exportAttempt * 5_000);
          exportAttempt += 1;
          continue;
        }
        // Once the task has terminalized successfully, download and validation
        // failures are permanent for this export and must surface to the audit.
        // Only failures while requesting/polling the accepted task are resumed.
        if (!taskIdToResume || lastPhase === 'downloading') throw error;
        // A task-status request can fail after task acceptance. Resume the same
        // task indefinitely instead of submitting a duplicate export.
        await ensureActive();
        await sleep(5_000);
      }
    }
    throw new Error('Menu export attempts were exhausted');
  }

  private async pollUploadTask(
    authToken: string,
    taskId: string,
    refreshAuthToken: () => Promise<string>,
    ensureActive: () => Promise<void>,
    rateLimitKey: string,
    onProgress: (value: { status?: number; polls: number; rateLimited: boolean }) => Promise<void>,
  ) {
    let polls = 0;
    let pollingToken = authToken;
    while (true) {
      await ensureActive();
      if (polls > 0) await sleep(UPLOAD_TASK_POLL_MS);
      polls += 1;
      try {
        const check = await checkGroceryUploadTaskOnce(
          pollingToken,
          taskId,
          refreshAuthToken,
          rateLimitKey,
        );
        pollingToken = check.authToken;
        await onProgress({ status: check.status, polls, rateLimited: check.rateLimited });
        if (!check.terminal) continue;
        if (check.status === undefined) throw new Error(`Upload task ${taskId} terminalized without a status`);
        return { status: check.status, failedItems: check.failedItems, polls };
      } catch {
        // Once uploadGrocery has returned a taskID, a check error is ambiguous.
        // Keep the same task authoritative and continue polling; never submit a
        // replacement task merely because status lookup is temporarily broken.
        try {
          await onProgress({ polls, rateLimited: false });
        } catch {
          // A progress-write outage must not abandon an accepted task. The
          // terminal callback above is retried on the same task until durable.
        }
      }
    }
  }

  private menuProgressMessage(progress: MenuDownloadProgress, exportAttempt: number, verification: boolean) {
    const purpose = verification ? 'verification export' : 'menu export';
    if (progress.phase === 'requested') return `Requested ${purpose} task (attempt ${exportAttempt}/${MAX_EXPORT_ATTEMPTS})`;
    if (progress.phase === 'downloading') return `Downloading completed ${purpose}`;
    if (progress.rateLimited) return `Waiting for the shared DiDi task-status window for ${purpose}`;
    return `Polling ${purpose} task until terminal status`;
  }

  private setTaskProgress(progress: ActiveShopProgress, taskId: string, status: number | undefined, polls: number) {
    progress.currentTaskId = taskId;
    progress.currentTaskStatus = status;
    progress.currentTaskPolls = polls;
  }

  private addUnique(values: string[], value: string) {
    if (value && !values.includes(value)) values.push(value);
  }

  private async resolveTargets(applicationId: string, requested: string[]) {
    const local = await this.prisma.shop.findMany({
      where: {
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
        OR: [{ shopId: { in: requested } }, { appShopId: { in: requested } }],
      },
      select: { shopId: true, appShopId: true },
    });
    const localByShopId = new Map(local.map(shop => [shop.shopId, shop.appShopId]));
    const localByAppShopId = new Map(local.map(shop => [shop.appShopId, shop.appShopId]));
    return requested.map(shopId => ({
      shopId,
      // No /v1/shop/shop/list call: unresolved values are treated as app_shop_id,
      // matching the input contract of the supplied script.
      appShopId: localByShopId.get(shopId) ?? localByAppShopId.get(shopId) ?? shopId,
    }));
  }

  private async mapWithConcurrency<T>(values: T[], concurrency: number, action: (value: T) => Promise<void>) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
      while (cursor < values.length) await action(values[cursor++]);
    });
    const settled = await Promise.allSettled(workers);
    const failure = settled.find(
      (value): value is PromiseRejectedResult => value.status === 'rejected'
        && !(value.reason instanceof UpcActivityPriceCancelledError),
    );
    if (failure) throw failure.reason;
  }

  private executionLease(executionId: string) {
    const lease = this.executionLeases.get(executionId);
    if (!lease) {
      throw new OperationalLeaseLostError(
        upcExecutionResourceKey(executionId),
        'UPC execution has no active fenced worker context',
      );
    }
    return lease;
  }

  private withExecutionFence<T>(
    executionId: string,
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.executionLease(executionId).withFencedTransaction(work);
  }

  private async ensureCanSubmit(executionId: string) {
    const lease = this.executionLease(executionId);
    await lease.ensureActive();
    const execution = await lease.withFencedTransaction(tx => tx.upcActivityPriceExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    }));
    if (!execution || execution.status !== 'running' || execution.cancelRequested) throw new UpcActivityPriceCancelledError();
  }

  private async ensureMonitorable(executionId: string) {
    const lease = this.executionLease(executionId);
    await lease.ensureActive();
    const execution = await lease.withFencedTransaction(tx => tx.upcActivityPriceExecution.findUnique({
      where: { id: executionId }, select: { status: true },
    }));
    if (!execution || execution.status !== 'running') throw new UpcActivityPriceCancelledError();
  }

  private async isCancellationRequested(executionId: string) {
    const execution = await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.findUnique({
      where: { id: executionId }, select: { cancelRequested: true },
    }));
    return !execution || execution.cancelRequested;
  }

  private async finishCancelled(executionId: string, results: ShopResult[], started: number) {
    await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: 'running', cancelRequested: true },
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        currentShopId: null,
        processedShops: results.length,
        successfulShops: results.filter(value => ['updated', 'partial_success', 'already_current'].includes(value.outcome)).length,
        skippedShops: results.filter(value => value.outcome === 'upc_not_found').length,
        failedShops: results.filter(value => value.outcome === 'failed').length,
        errorMessage: 'Stopped manually after every accepted remote task reached a terminal state',
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    }));
  }

  private async saveProgress(
    executionId: string,
    results: ShopResult[],
    activeShops: Map<string, ActiveShopProgress> = new Map(),
  ) {
    await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.update({
      where: { id: executionId },
      data: {
        processedShops: results.length,
        successfulShops: results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length,
        skippedShops: results.filter(value => value.outcome === 'upc_not_found').length,
        failedShops: results.filter(value => value.outcome === 'failed').length,
        result: { shops: results, activeShops: [...activeShops.values()] } as unknown as Prisma.InputJsonValue,
      },
    }));
  }

  private async blockForManualReview(
    executionId: string,
    message: string,
    results: ShopResult[],
    activeShops: Map<string, ActiveShopProgress>,
  ) {
    await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: {
        cancelRequested: true,
        manualReviewRequired: true,
        manualReviewReason: message,
        currentShopId: null,
        errorMessage: `Manual review required; no automatic resubmission: ${message}`,
        result: {
          shops: results,
          activeShops: [...activeShops.values()],
          requiresManualReview: true,
          manualReviewReason: message,
        } as unknown as Prisma.InputJsonValue,
      },
    }));
  }

  private async markRecoveryPending(
    executionId: string,
    message: string,
    results: ShopResult[],
    activeShops: Map<string, ActiveShopProgress>,
  ) {
    await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        errorMessage: `Recovery pending for the same execution/taskID: ${message}`,
        result: { shops: results, activeShops: [...activeShops.values()] } as unknown as Prisma.InputJsonValue,
      },
    }));
  }

  private async fail(executionId: string, message: string, results: ShopResult[], started: number) {
    await this.withExecutionFence(executionId, tx => tx.upcActivityPriceExecution.updateMany({
      where: { id: executionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        currentShopId: null,
        processedShops: results.length,
        successfulShops: results.filter(value => ['updated', 'partial_success', 'would_update', 'already_current'].includes(value.outcome)).length,
        skippedShops: results.filter(value => value.outcome === 'upc_not_found').length,
        failedShops: results.filter(value => value.outcome === 'failed').length,
        manualReviewRequired: false,
        manualReviewReason: null,
        errorMessage: message,
        result: { shops: results } as unknown as Prisma.InputJsonValue,
      },
    }));
  }

  private safeError(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
      .replace(/app_secret[=:]\s*[^\s,;&]+/gi, 'app_secret=<redacted>')
      .replace(/auth_token[=:]\s*[^\s,;&]+/gi, 'auth_token=<redacted>')
      .slice(0, 1200);
  }
}
