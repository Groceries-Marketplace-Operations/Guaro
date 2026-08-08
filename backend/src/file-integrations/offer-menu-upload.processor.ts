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
import { getAuthToken } from '../queue/handlers/didi-food.util';
import { wildcardToRegExp } from './file-integration.util';
import { GroceryItemFailure, uploadGroceryBatch } from './grocery-menu-upload.util';
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
  dryRun: boolean;
  error?: string;
}

@Injectable()
@Processor('offer-menu-upload', { concurrency: 2 })
export class OfferMenuUploadProcessor extends WorkerHost {
  private readonly logger = new Logger(OfferMenuUploadProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sftp: SftpConnectionService,
    private readonly config: ConfigService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const started = Date.now();
    const claimed = await this.prisma.offerMenuUploadExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), errorMessage: null },
    });
    if (!claimed.count) return;
    const execution = await this.prisma.offerMenuUploadExecution.findUnique({
      where: { id: executionId },
      include: { rule: { include: { application: true } } },
    });
    if (!execution) return;
    const { rule } = execution;
    const results: StoreResult[] = [];
    const tempRoot = await mkdtemp(join(tmpdir(), 'tequila-offer-'));
    try {
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
        try {
          appSecret = decrypt(rule.application.appSecret, this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY'));
        } catch {
          throw new Error(`Credential for application ${rule.application.appName} could not be decrypted`);
        }
      }
      let progressChain = Promise.resolve();
      let duplicateItems = 0;
      let uniqueItems = 0;
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
          const result = await this.processStore(executionId, rule, appSecret, storeId, appShopId, items);
          results.push(result);
          if (results.length % 10 === 0 || results.length === storeIds.size) {
            progressChain = progressChain.then(() => this.saveProgress(executionId, results, storeId));
            await progressChain;
          }
        });
        grouped.clear();
      }
      await progressChain;
      await this.ensureActive(executionId);

      const successfulStores = results.filter(value => value.status !== 'failed').length;
      const failedStores = results.length - successfulStores;
      const uploadedItems = results.reduce((sum, value) => sum + value.uploadedItems, 0);
      const failedItems = results.reduce((sum, value) => sum + value.failedItems.length, 0);
      const hasWarnings = failedStores > 0 || failedItems > 0 || parsed.rowsRejected > 0;
      const status: AutoOpenStatus = successfulStores === 0
        ? AutoOpenStatus.failed
        : hasWarnings ? AutoOpenStatus.partial_success : AutoOpenStatus.done;
      const now = new Date();
      const errorMessage = hasWarnings
        ? `${failedStores} store(s) failed; ${failedItems} item(s) failed; ${parsed.rowsRejected} CSV row(s) rejected`
        : null;
      const markSourceDone = !rule.dryRun && status === AutoOpenStatus.done;
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
            totalItems: uniqueItems,
            errorMessage,
            result: {
              stores: results,
              csv: {
                rowsRead: parsed.rowsRead,
                rowsAccepted: parsed.rowsAccepted,
                rowsRejected: parsed.rowsRejected,
                duplicateItems,
                errors: parsed.errors,
              },
              dryRun: rule.dryRun,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.offerMenuUploadRule.update({
          where: { id: rule.id },
          data: {
            lastRunAt: now,
            lastSourceFile: markSourceDone ? source.latest.name : undefined,
            lastSourceModifiedAt: markSourceDone ? modifiedAt : undefined,
            lastSourceSize: markSourceDone ? BigInt(source.latest.size) : undefined,
          },
        }),
      ]);
      this.logger.log(`Offer menu ${rule.name}: ${status}; ${successfulStores}/${results.length} stores; dryRun=${rule.dryRun}`);
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

  private async processStore(
    executionId: string,
    rule: Awaited<ReturnType<typeof this.loadRuleShape>>,
    appSecret: string,
    storeId: string,
    appShopId: string,
    items: OfferMenuItem[],
  ): Promise<StoreResult> {
    const taskIds: string[] = [];
    const failedItems: GroceryItemFailure[] = [];
    let uploadedItems = 0;
    if (items.length > rule.maxItemsPerStore) {
      return {
        storeId, appShopId, status: 'failed', itemCount: items.length, uploadedItems, taskIds, failedItems, dryRun: rule.dryRun,
        error: `Store has ${items.length} items; configured maximum is ${rule.maxItemsPerStore}`,
      };
    }
    if (rule.dryRun) {
      return { storeId, appShopId, status: 'done', itemCount: items.length, uploadedItems: 0, taskIds, failedItems, dryRun: true };
    }
    try {
      let authToken = await getAuthToken(rule.application.appId, appSecret, appShopId);
      const refresh = async () => {
        authToken = await getAuthToken(rule.application.appId, appSecret, appShopId);
        return authToken;
      };
      const request = buildOfferMenuRequest(rule, appShopId, items);
      await this.ensureActive(executionId);
      const upload = await uploadGroceryBatch(
        authToken,
        request,
        'uploadGrocery',
        rule.mergePolicy,
        () => this.ensureActive(executionId),
        refresh,
      );
      taskIds.push(upload.referenceId);
      failedItems.push(...upload.failedItems);
      uploadedItems = upload.acceptedCount;
      return {
        storeId,
        appShopId,
        status: uploadedItems === 0 ? 'failed' : failedItems.length ? 'partial_success' : 'done',
        itemCount: items.length,
        uploadedItems,
        taskIds,
        failedItems,
        dryRun: false,
        error: uploadedItems === 0 ? 'No item was accepted by the menu endpoint' : undefined,
      };
    } catch (error) {
      if (error instanceof OfferMenuCancelledError) throw error;
      return {
        storeId,
        appShopId,
        status: uploadedItems > 0 ? 'partial_success' : 'failed',
        itemCount: items.length,
        uploadedItems,
        taskIds,
        failedItems,
        dryRun: false,
        error: this.safeError(error),
      };
    }
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

  private async saveProgress(executionId: string, results: StoreResult[], currentStoreId: string) {
    await this.prisma.offerMenuUploadExecution.update({
      where: { id: executionId },
      data: {
        currentStoreId,
        processedStores: results.length,
        successfulStores: results.filter(value => value.status !== 'failed').length,
        failedStores: results.filter(value => value.status === 'failed').length,
        uploadedItems: results.reduce((sum, value) => sum + value.uploadedItems, 0),
        failedItems: results.reduce((sum, value) => sum + value.failedItems.length, 0),
        result: { stores: results } as unknown as Prisma.InputJsonValue,
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
