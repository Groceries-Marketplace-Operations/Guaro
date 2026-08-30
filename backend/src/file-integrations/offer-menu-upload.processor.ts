import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { createInterface } from 'readline';
import { once } from 'events';
import { finished } from 'stream/promises';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { catalogMutationResourceKey, OperationalLeaseService } from '../prisma/operational-lease.service';
import { getAuthToken } from '../queue/handlers/didi-food.util';
import { wildcardToRegExp } from './file-integration.util';
import {
  checkGroceryUploadTaskOnce,
  GROCERY_TASK_STATUS_MIN_INTERVAL_MS,
  GroceryItemFailure,
  resolveGroceryBatchSubmission,
  submitGroceryBatch,
} from './grocery-menu-upload.util';
import { buildOfferMenuRequest, OfferMenuItem, streamOfferMenuCsv } from './offer-menu-upload.util';
import { SftpConnectionService } from './sftp-connection.service';

class OfferMenuCancelledError extends Error {}

interface StoreResult {
  storeId: string;
  appShopId: string;
  status: 'done' | 'partial_success' | 'failed';
  itemCount: number;
  uploadedItems: number;
  taskIds: string[];
  failedItems: GroceryItemFailure[];
  failedItemCount: number;
  dryRun: boolean;
  error?: string;
}

interface PendingStoreUpload {
  storeId: string;
  appShopId: string;
  itemCount: number;
  taskId: string;
  authToken?: string;
}

interface StoreSubmission {
  pending?: PendingStoreUpload;
  result?: StoreResult;
}

type OfferMenuPhase = 'submitting' | 'checking_status' | 'complete';
const MAX_STORED_FAILED_ITEM_SAMPLES = 100;

interface OfferCompletionStats {
  submissionProcessedStores: number;
  submittedStores: number;
  checkedStores: number;
  uniqueItems: number;
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  duplicateItems: number;
  csvErrors: string[];
}

@Injectable()
@Processor('offer-menu-upload', { concurrency: 2 })
export class OfferMenuUploadProcessor extends WorkerHost {
  private readonly logger = new Logger(OfferMenuUploadProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sftp: SftpConnectionService,
    private readonly config: ConfigService,
    private readonly leases: OperationalLeaseService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.prisma.offerMenuUploadExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', errorMessage: null },
    });
    if (!claimed.count) return;
    const execution = await this.prisma.offerMenuUploadExecution.findUnique({
      where: { id: executionId },
      include: { rule: { include: { application: true } } },
    });
    if (!execution) return;
    const { rule } = execution;
    const started = execution.startedAt?.getTime() ?? Date.now();
    if (!execution.startedAt) {
      await this.prisma.offerMenuUploadExecution.update({
        where: { id: executionId },
        data: { startedAt: new Date(started) },
      });
    }
    const results: StoreResult[] = [];
    const tempRoot = await mkdtemp(join(tmpdir(), 'tequila-offer-'));
    try {
      const resumed = this.restoreStatusProgress(execution.result, execution.totalStores, execution.totalItems);
      if (resumed) {
        results.push(...resumed.results);
        const appSecret = this.decryptAppSecret(rule);
        await this.cleanupTemp(tempRoot);
        const checkedStores = await this.resolvePendingSubmissions(
          executionId,
          rule,
          appSecret,
          resumed.pendingUploads,
          results,
          resumed.stats,
        );
        await this.completeExecution(executionId, rule, started, results, {
          ...resumed.stats,
          checkedStores,
        }, {
          file: execution.sourceFile,
          modifiedAt: execution.sourceModifiedAt,
          size: execution.sourceSize,
        });
        return;
      }
      const source = await this.sftp.withClient(rule.sftpApplicationId, async (client, rootPath) => {
        await this.ensureActive(executionId);
        const matcher = wildcardToRegExp(rule.filePattern);
        const files = (await this.withTimeout(client.list(rootPath), 'SFTP directory listing'))
          .filter(file => file.type === '-' && matcher.test(file.name))
          .sort((left, right) => right.modifyTime - left.modifyTime || right.name.localeCompare(left.name));
        if (!files.length) throw new Error(`No SFTP file matches ${rule.filePattern} in ${rootPath}`);
        const latest = files[0];
        const unchanged = rule.lastSourceFile === latest.name
          && rule.lastSourceModifiedAt?.getTime() === latest.modifyTime
          && rule.lastSourceSize === BigInt(latest.size);
        if (unchanged && !execution.force && !rule.dryRun) {
          return { latest, localPath: null as string | null };
        }
        const remotePath = this.sftp.safeRemotePath(rootPath, latest.name);
        const localPath = join(tempRoot, 'source.csv');
        await this.withTimeout(
          client.fastGet(remotePath, localPath, { concurrency: 16, chunkSize: 64 * 1024 }),
          `download of ${latest.name}`,
          30 * 60_000,
        );
        return { latest, localPath };
      });
      const modifiedAt = new Date(source.latest.modifyTime);
      await this.prisma.offerMenuUploadExecution.update({
        where: { id: executionId },
        data: {
          sourceFile: source.latest.name,
          sourceModifiedAt: modifiedAt,
          sourceSize: BigInt(source.latest.size),
        },
      });
      if (!source.localPath) {
        const now = new Date();
        await this.prisma.$transaction([
          this.prisma.offerMenuUploadExecution.update({
            where: { id: executionId },
            data: {
              status: 'done',
              finishedAt: now,
              durationMs: Date.now() - started,
              result: { skipped: true, reason: 'Latest offer file was already uploaded successfully' },
            },
          }),
          this.prisma.offerMenuUploadRule.update({ where: { id: rule.id }, data: { lastRunAt: now } }),
        ]);
        return;
      }

      const bucketCount = 64;
      const bucketPaths = Array.from({ length: bucketCount }, (_, index) => join(tempRoot, `bucket-${index}.jsonl`));
      const writers = bucketPaths.map(value => createWriteStream(value, { encoding: 'utf8' }));
      const storeIds = new Set<string>();
      let parsed: Awaited<ReturnType<typeof streamOfferMenuCsv>>;
      try {
        parsed = await streamOfferMenuCsv(createReadStream(source.localPath), rule.delimiter, async item => {
          storeIds.add(item.storeId);
          const writer = writers[this.bucketFor(item.storeId, bucketCount)];
          if (!writer.write(`${JSON.stringify(item)}\n`)) await once(writer, 'drain');
        });
      } finally {
        for (const writer of writers) writer.end();
        await Promise.allSettled(writers.map(writer => finished(writer)));
      }
      const mapping = await this.resolveAppShopIds(rule.applicationId, [...storeIds]);
      await this.prisma.offerMenuUploadExecution.update({
        where: { id: executionId },
        data: { totalStores: storeIds.size, totalItems: parsed.rowsAccepted },
      });

      let appSecret = '';
      if (!rule.dryRun) {
        appSecret = this.decryptAppSecret(rule);
      }
      let progressChain = Promise.resolve();
      let duplicateItems = 0;
      let uniqueItems = 0;
      let submissionProcessedStores = 0;
      const pendingUploads: PendingStoreUpload[] = [];
      for (const bucketPath of bucketPaths) {
        await this.ensureActive(executionId);
        const grouped = new Map<string, Map<string, OfferMenuItem>>();
        const lines = createInterface({ input: createReadStream(bucketPath), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line) continue;
          const item = JSON.parse(line) as OfferMenuItem;
          const store = grouped.get(item.storeId) ?? new Map<string, OfferMenuItem>();
          if (store.has(item.sku)) duplicateItems += 1;
          store.set(item.sku, item);
          grouped.set(item.storeId, store);
        }
        const entries = [...grouped].map(([storeId, items]) => [storeId, [...items.values()]] as [string, OfferMenuItem[]])
          .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
        uniqueItems += entries.reduce((sum, [, items]) => sum + items.length, 0);
        await this.mapWithConcurrency(entries, rule.storeConcurrency, async ([storeId, items]) => {
          await this.ensureActive(executionId);
          const appShopId = mapping.get(storeId) ?? storeId;
          const submission = await this.submitStore(executionId, rule, appSecret, storeId, appShopId, items);
          if (submission.pending) pendingUploads.push(submission.pending);
          if (submission.result) results.push(submission.result);
          submissionProcessedStores += 1;
          if (submissionProcessedStores % 10 === 0 || submissionProcessedStores === storeIds.size) {
            progressChain = progressChain.then(() => this.saveProgress(executionId, {
              phase: 'submitting',
              results,
              currentStoreId: storeId,
              submissionProcessedStores,
              submittedStores: pendingUploads.length,
              totalStores: storeIds.size,
              pendingUploads,
            }));
            await progressChain;
          }
        });
        grouped.clear();
      }
      await progressChain;
      await this.ensureActive(executionId);

      const completionStats: OfferCompletionStats = {
        submissionProcessedStores,
        submittedStores: pendingUploads.length,
        checkedStores: 0,
        uniqueItems,
        rowsRead: parsed.rowsRead,
        rowsAccepted: parsed.rowsAccepted,
        rowsRejected: parsed.rowsRejected,
        duplicateItems,
        csvErrors: parsed.errors,
      };
      if (pendingUploads.length) {
        await this.saveProgress(executionId, {
          phase: 'checking_status',
          results,
          currentStoreId: null,
          submissionProcessedStores,
          submittedStores: pendingUploads.length,
          totalStores: storeIds.size,
          pendingUploads,
          stats: completionStats,
        });
        // Bucket files are no longer needed once every menu has been submitted.
        // Removing them here prevents a long task-status phase from retaining
        // hundreds of MB of temporary data.
        await this.cleanupTemp(tempRoot);
        completionStats.checkedStores = await this.resolvePendingSubmissions(
          executionId,
          rule,
          appSecret,
          pendingUploads,
          results,
          completionStats,
        );
        await this.ensureActive(executionId);
      }
      await this.completeExecution(executionId, rule, started, results, completionStats, {
        file: source.latest.name,
        modifiedAt,
        size: BigInt(source.latest.size),
      });
    } catch (error) {
      if (error instanceof OfferMenuCancelledError) return;
      const message = this.safeError(error);
      await this.prisma.offerMenuUploadExecution.updateMany({
        where: { id: executionId, status: { in: ['pending', 'running'] } },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          currentStoreId: null,
          errorMessage: message,
          result: { stores: results } as unknown as Prisma.InputJsonValue,
        },
      });
      throw error;
    } finally {
      await this.cleanupTemp(tempRoot);
    }
  }

  private async submitStore(
    executionId: string,
    rule: Awaited<ReturnType<typeof this.loadRuleShape>>,
    appSecret: string,
    storeId: string,
    appShopId: string,
    items: OfferMenuItem[],
  ): Promise<StoreSubmission> {
    const taskIds: string[] = [];
    const failedItems: GroceryItemFailure[] = [];
    if (items.length > rule.maxItemsPerStore) {
      return { result: {
        storeId, appShopId, status: 'failed', itemCount: items.length, uploadedItems: 0, taskIds, failedItems, failedItemCount: 0, dryRun: rule.dryRun,
        error: `Store has ${items.length} items; configured maximum is ${rule.maxItemsPerStore}`,
      } };
    }
    if (rule.dryRun) {
      return { result: { storeId, appShopId, status: 'done', itemCount: items.length, uploadedItems: 0, taskIds, failedItems, failedItemCount: 0, dryRun: true } };
    }
    try {
      return await this.leases.runExclusive({
        resourceKey: catalogMutationResourceKey(rule.applicationId, appShopId),
        ownerKind: 'offer-menu',
        ownerId: `${executionId}:${appShopId}`,
        ttlMs: 5 * 60_000,
        heartbeatIntervalMs: 30_000,
        wait: true,
        waitTimeoutMs: 15 * 60_000,
        retryDelayMs: 1_000,
        ensureActive: () => this.ensureActive(executionId),
      }, async catalogLease => {
      const ensureStoreActive = async () => {
        await this.ensureActive(executionId);
        await catalogLease.ensureActive();
      };
      const authToken = await getAuthToken(rule.application.appId, appSecret, appShopId);
      const request = buildOfferMenuRequest(rule, appShopId, items);
      await ensureStoreActive();
      const submission = await submitGroceryBatch(
        authToken,
        request,
        'uploadGrocery',
        rule.mergePolicy,
      );
      if ('acceptedCount' in submission) throw new Error('uploadGrocery unexpectedly returned a synchronous result');
      const completed = await resolveGroceryBatchSubmission(
        authToken,
        submission.referenceId,
        items.length,
        ensureStoreActive,
        () => getAuthToken(rule.application.appId, appSecret, appShopId),
        4 * 60 * 60_000,
        rule.application.appId,
      );
      const failedItemCount = completed.failedItems.length;
      const uploadedItems = Math.max(0, items.length - failedItemCount);
      return { result: {
        storeId,
        appShopId,
        itemCount: items.length,
        status: uploadedItems === 0 ? 'failed' : failedItemCount ? 'partial_success' : 'done',
        uploadedItems,
        taskIds: [submission.referenceId],
        failedItems: completed.failedItems.slice(0, MAX_STORED_FAILED_ITEM_SAMPLES),
        failedItemCount,
        dryRun: false,
        error: uploadedItems === 0 ? 'No item was accepted by the menu endpoint' : undefined,
      } };
      });
    } catch (error) {
      if (error instanceof OfferMenuCancelledError) throw error;
      return { result: {
        storeId,
        appShopId,
        status: 'failed',
        itemCount: items.length,
        uploadedItems: 0,
        taskIds,
        failedItems,
        failedItemCount: 0,
        dryRun: false,
        error: this.safeError(error),
      } };
    }
  }

  private async resolvePendingSubmissions(
    executionId: string,
    rule: Awaited<ReturnType<typeof this.loadRuleShape>>,
    appSecret: string,
    pendingUploads: PendingStoreUpload[],
    results: StoreResult[],
    stats: OfferCompletionStats,
  ): Promise<number> {
    const resolvedTaskIds = new Set(results.flatMap(value => value.taskIds));
    const queue = pendingUploads.filter(value => !resolvedTaskIds.has(value.taskId));
    let checkedStores = pendingUploads.length - queue.length;
    let statusPolls = 0;
    let rateLimitedPolls = 0;
    const deadline = Date.now() + Math.max(
      4 * 60 * 60_000,
      queue.length * GROCERY_TASK_STATUS_MIN_INTERVAL_MS * 3,
    );

    while (queue.length) {
      await this.ensureActive(executionId);
      if (Date.now() >= deadline) {
        for (const pending of queue.splice(0)) {
          results.push({
            storeId: pending.storeId,
            appShopId: pending.appShopId,
            status: 'failed',
            itemCount: pending.itemCount,
            uploadedItems: 0,
            taskIds: [pending.taskId],
            failedItems: [],
            failedItemCount: 0,
            dryRun: false,
            error: 'Menu task status did not reach a terminal state before the monitoring deadline',
          });
          checkedStores += 1;
        }
        break;
      }

      const pending = queue.shift()!;
      try {
        if (!pending.authToken) {
          pending.authToken = await getAuthToken(rule.application.appId, appSecret, pending.appShopId);
        }
        const check = await checkGroceryUploadTaskOnce(
          pending.authToken,
          pending.taskId,
          () => getAuthToken(rule.application.appId, appSecret, pending.appShopId),
          rule.application.appId,
        );
        pending.authToken = check.authToken;
        statusPolls += 1;
        if (!check.terminal) {
          if (check.rateLimited) rateLimitedPolls += 1;
          queue.push(pending);
        } else {
          const failedItemCount = check.failedItems.length;
          const uploadedItems = check.status === 2
            ? 0
            : Math.max(0, pending.itemCount - failedItemCount);
          const detail = check.failedItems.slice(0, 10)
            .map(item => `${item.appItemId}: ${item.reason}`)
            .join('; ');
          results.push({
            storeId: pending.storeId,
            appShopId: pending.appShopId,
            status: check.status === 2 || uploadedItems === 0
              ? 'failed'
              : failedItemCount ? 'partial_success' : 'done',
            itemCount: pending.itemCount,
            uploadedItems,
            taskIds: [pending.taskId],
            failedItems: check.failedItems.slice(0, MAX_STORED_FAILED_ITEM_SAMPLES),
            failedItemCount,
            dryRun: false,
            error: check.status === 2
              ? `DiDi reported a failed upload task${detail ? `: ${detail}` : ''}`
              : uploadedItems === 0 ? 'No item was accepted by the menu endpoint' : undefined,
          });
          checkedStores += 1;
        }
      } catch (error) {
        if (error instanceof OfferMenuCancelledError) throw error;
        results.push({
          storeId: pending.storeId,
          appShopId: pending.appShopId,
          status: 'failed',
          itemCount: pending.itemCount,
          uploadedItems: 0,
          taskIds: [pending.taskId],
          failedItems: [],
          failedItemCount: 0,
          dryRun: false,
          error: this.safeError(error),
        });
        checkedStores += 1;
      }

      if (statusPolls % 10 === 0 || queue.length === 0 || checkedStores === pendingUploads.length) {
        await this.saveProgress(executionId, {
          phase: 'checking_status',
          results,
          currentStoreId: pending.storeId,
          submissionProcessedStores: stats.submissionProcessedStores,
          submittedStores: stats.submittedStores,
          checkedStores,
          totalStores: stats.submissionProcessedStores,
          pendingUploads,
          stats,
          statusPolls,
          rateLimitedPolls,
          pendingStatusChecks: queue.length,
        });
      }
    }
    return checkedStores;
  }

  private restoreStatusProgress(
    value: Prisma.JsonValue | null,
    totalStores: number,
    totalItems: number,
  ): { pendingUploads: PendingStoreUpload[]; results: StoreResult[]; stats: OfferCompletionStats } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const progress = value as Record<string, unknown>;
    if (progress.phase !== 'checking_status' || !Array.isArray(progress.submittedTasks) || !progress.submittedTasks.length) return null;
    const pendingUploads = progress.submittedTasks.flatMap(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const task = entry as Record<string, unknown>;
      const taskId = String(task.taskId ?? '');
      const storeId = String(task.storeId ?? '');
      const appShopId = String(task.appShopId ?? '');
      const itemCount = Number(task.itemCount ?? 0);
      return taskId && storeId && appShopId && Number.isFinite(itemCount)
        ? [{ taskId, storeId, appShopId, itemCount }]
        : [];
    });
    if (!pendingUploads.length) return null;
    const results = Array.isArray(progress.stores)
      ? (progress.stores as unknown as StoreResult[]).map(result => ({
        ...result,
        failedItemCount: result.failedItemCount ?? result.failedItems?.length ?? 0,
        failedItems: Array.isArray(result.failedItems)
          ? result.failedItems.slice(0, MAX_STORED_FAILED_ITEM_SAMPLES)
          : [],
      }))
      : [];
    const csv = progress.csv && typeof progress.csv === 'object' && !Array.isArray(progress.csv)
      ? progress.csv as Record<string, unknown>
      : {};
    return {
      pendingUploads,
      results,
      stats: {
        submissionProcessedStores: Number(progress.submissionProcessedStores ?? totalStores),
        submittedStores: Number(progress.submittedStores ?? pendingUploads.length),
        checkedStores: Number(progress.checkedStores ?? 0),
        uniqueItems: Number(progress.uniqueItems ?? totalItems),
        rowsRead: Number(csv.rowsRead ?? totalItems),
        rowsAccepted: Number(csv.rowsAccepted ?? totalItems),
        rowsRejected: Number(csv.rowsRejected ?? 0),
        duplicateItems: Number(csv.duplicateItems ?? 0),
        csvErrors: Array.isArray(csv.errors) ? csv.errors.map(String) : [],
      },
    };
  }

  private decryptAppSecret(rule: Awaited<ReturnType<typeof this.loadRuleShape>>) {
    try {
      return decrypt(rule.application.appSecret, this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY'));
    } catch {
      throw new Error(`Credential for application ${rule.application.appName} could not be decrypted`);
    }
  }

  private async completeExecution(
    executionId: string,
    rule: Awaited<ReturnType<typeof this.loadRuleShape>>,
    started: number,
    results: StoreResult[],
    stats: OfferCompletionStats,
    source: { file: string | null; modifiedAt: Date | null; size: bigint | null },
  ) {
    const successfulStores = results.filter(value => value.status !== 'failed').length;
    const failedStores = results.length - successfulStores;
    const uploadedItems = results.reduce((sum, value) => sum + value.uploadedItems, 0);
    const failedItems = results.reduce((sum, value) => sum + (value.failedItemCount ?? value.failedItems.length), 0);
    const hasWarnings = failedStores > 0 || failedItems > 0 || stats.rowsRejected > 0;
    const status: AutoOpenStatus = successfulStores === 0
      ? AutoOpenStatus.failed
      : hasWarnings ? AutoOpenStatus.partial_success : AutoOpenStatus.done;
    const now = new Date();
    const errorMessage = hasWarnings
      ? `${failedStores} store(s) failed; ${failedItems} item(s) failed; ${stats.rowsRejected} CSV row(s) rejected`
      : null;
    // A partial success is still a processed source file. Re-uploading the
    // unchanged file cannot repair missing shop authorization or unknown UPCs.
    const markSourceDone = !rule.dryRun && status !== AutoOpenStatus.failed;
    await this.prisma.$transaction([
      this.prisma.offerMenuUploadExecution.update({
        where: { id: executionId },
        data: {
          status,
          finishedAt: now,
          durationMs: Date.now() - started,
          currentStoreId: null,
          processedStores: results.length,
          successfulStores,
          failedStores,
          uploadedItems,
          failedItems,
          totalItems: stats.uniqueItems,
          errorMessage,
          result: {
            phase: 'complete',
            submissionProcessedStores: stats.submissionProcessedStores,
            submittedStores: stats.submittedStores,
            checkedStores: stats.checkedStores,
            stores: results,
            csv: {
              rowsRead: stats.rowsRead,
              rowsAccepted: stats.rowsAccepted,
              rowsRejected: stats.rowsRejected,
              duplicateItems: stats.duplicateItems,
              errors: stats.csvErrors,
            },
            dryRun: rule.dryRun,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
      this.prisma.offerMenuUploadRule.update({
        where: { id: rule.id },
        data: {
          lastRunAt: now,
          lastSourceFile: markSourceDone && source.file ? source.file : undefined,
          lastSourceModifiedAt: markSourceDone && source.modifiedAt ? source.modifiedAt : undefined,
          lastSourceSize: markSourceDone && source.size !== null ? source.size : undefined,
        },
      }),
    ]);
    this.logger.log(`Offer menu ${rule.name}: ${status}; ${successfulStores}/${results.length} stores; dryRun=${rule.dryRun}`);
  }

  private async resolveAppShopIds(applicationId: string, storeIds: string[]) {
    const shops = await this.prisma.shop.findMany({
      where: {
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
        OR: [{ shopId: { in: storeIds } }, { appShopId: { in: storeIds } }],
      },
      select: { shopId: true, appShopId: true },
    });
    const result = new Map<string, string>();
    for (const shop of shops) {
      result.set(shop.shopId, shop.appShopId);
      result.set(shop.appShopId, shop.appShopId);
    }
    return result;
  }

  private async mapWithConcurrency<T>(values: T[], concurrency: number, action: (value: T) => Promise<void>) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++];
        await action(value);
      }
    });
    await Promise.all(workers);
  }

  private bucketFor(value: string, bucketCount: number) {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return (hash >>> 0) % bucketCount;
  }

  private async saveProgress(executionId: string, progress: {
    phase: OfferMenuPhase;
    results: StoreResult[];
    currentStoreId: string | null;
    submissionProcessedStores: number;
    submittedStores: number;
    totalStores: number;
    checkedStores?: number;
    pendingUploads?: PendingStoreUpload[];
    stats?: OfferCompletionStats;
    statusPolls?: number;
    rateLimitedPolls?: number;
    pendingStatusChecks?: number;
  }) {
    const { results } = progress;
    await this.prisma.offerMenuUploadExecution.update({
      where: { id: executionId },
      data: {
        currentStoreId: progress.currentStoreId,
        processedStores: results.length,
        successfulStores: results.filter(value => value.status !== 'failed').length,
        failedStores: results.filter(value => value.status === 'failed').length,
        uploadedItems: results.reduce((sum, value) => sum + value.uploadedItems, 0),
        failedItems: results.reduce((sum, value) => sum + (value.failedItemCount ?? value.failedItems.length), 0),
        result: {
          phase: progress.phase,
          submissionProcessedStores: progress.submissionProcessedStores,
          submittedStores: progress.submittedStores,
          checkedStores: progress.checkedStores ?? 0,
          totalStores: progress.totalStores,
          statusPolls: progress.statusPolls ?? 0,
          rateLimitedPolls: progress.rateLimitedPolls ?? 0,
          pendingStatusChecks: progress.pendingStatusChecks ?? progress.pendingUploads?.length ?? 0,
          uniqueItems: progress.stats?.uniqueItems,
          csv: progress.stats ? {
            rowsRead: progress.stats.rowsRead,
            rowsAccepted: progress.stats.rowsAccepted,
            rowsRejected: progress.stats.rowsRejected,
            duplicateItems: progress.stats.duplicateItems,
            errors: progress.stats.csvErrors,
          } : undefined,
          submittedTasks: progress.pendingUploads?.map(value => ({
            storeId: value.storeId,
            appShopId: value.appShopId,
            itemCount: value.itemCount,
            taskId: value.taskId,
          })) ?? [],
          stores: results,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async ensureActive(executionId: string) {
    const execution = await this.prisma.offerMenuUploadExecution.findUnique({
      where: { id: executionId }, select: { status: true, cancelRequested: true },
    });
    if (!execution || execution.status !== 'running' || execution.cancelRequested) throw new OfferMenuCancelledError();
  }

  private async withTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 60_000) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async cleanupTemp(value: string) {
    const target = resolve(value);
    const safeParent = resolve(tmpdir());
    if (dirname(target) !== safeParent || !basename(target).startsWith('tequila-offer-')) {
      this.logger.error(`Refused unsafe offer menu temporary cleanup: ${target}`);
      return;
    }
    await rm(target, { recursive: true, force: true }).catch(error => {
      this.logger.warn(`Could not remove offer menu temporary directory: ${this.safeError(error)}`);
    });
  }

  private safeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replace(/app_secret[=:]\s*[^\s,;&]+/gi, 'app_secret=<redacted>')
      .replace(/password[=:]\s*[^\s,;&]+/gi, 'password=<redacted>')
      .replace(/auth_token[=:]\s*[^\s,;&]+/gi, 'auth_token=<redacted>')
      .slice(0, 1200);
  }

  private loadRuleShape() {
    return this.prisma.offerMenuUploadRule.findFirstOrThrow({ include: { application: true } });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ executionId: string }> | undefined, error: Error) {
    if (!job?.data.executionId) return;
    await this.prisma.offerMenuUploadExecution.updateMany({
      where: { id: job.data.executionId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), currentStoreId: null, errorMessage: this.safeError(error) },
    });
  }
}
