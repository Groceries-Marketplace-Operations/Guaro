import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AutoOpenStatus,
  DidiBindingEnvironment,
  DidiStoreBindingAction,
  DidiStoreBindingItemStatus,
} from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { COOLDOWN_BATCH_MS, COOLDOWN_SHOPLIST_MS, sleep } from '../queue/handlers/didi-food.util';
import { DidiStoreBindingExecutionsService } from './didi-store-binding-executions.service';
import { DidiStoreBindingsService } from './didi-store-bindings.service';
import { DidiBindingResult, redactSensitiveText } from './didi-store-bindings.util';

interface ExecutionJob {
  executionId: string;
}

const isActiveExecution = (status: AutoOpenStatus) => (
  status === AutoOpenStatus.pending || status === AutoOpenStatus.running
);

@Injectable()
@Processor('didi-store-bindings', { concurrency: 2 })
export class DidiStoreBindingExecutionProcessor extends WorkerHost {
  private readonly logger = new Logger(DidiStoreBindingExecutionProcessor.name);
  private readonly batchCooldownMs: number;
  private readonly pageCooldownMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bindings: DidiStoreBindingsService,
    private readonly executions: DidiStoreBindingExecutionsService,
    @Optional() config?: ConfigService,
  ) {
    super();
    const productionConfig = config instanceof ConfigService;
    const batch = Number(config?.get('DIDI_STORE_BINDINGS_BIND_BATCH_COOLDOWN_MS', String(COOLDOWN_BATCH_MS)));
    const page = Number(config?.get('DIDI_STORE_BINDINGS_SHOP_LIST_COOLDOWN_MS', String(COOLDOWN_SHOPLIST_MS)));
    this.batchCooldownMs = productionConfig && Number.isFinite(batch) && batch >= COOLDOWN_BATCH_MS
      ? batch
      : productionConfig ? COOLDOWN_BATCH_MS : 1;
    this.pageCooldownMs = productionConfig && Number.isFinite(page) && page >= COOLDOWN_SHOPLIST_MS
      ? page
      : productionConfig ? COOLDOWN_SHOPLIST_MS : 1;
  }

  async process(job: Job<ExecutionJob>) {
    const initial = await this.prisma.didiStoreBindingExecution.findUnique({
      where: { id: job.data.executionId },
    });
    if (!initial || !isActiveExecution(initial.status)) return;

    return this.bindings.withDurableOperationLock(initial.applicationId, async () => {
      const execution = await this.prisma.didiStoreBindingExecution.findUnique({
        where: { id: initial.id },
      });
      if (!execution || !isActiveExecution(execution.status)) return;

      // A previous worker may have stopped at either side of the POST boundary.
      // processing is pre-submit and safe to retry; submitting is ambiguous and
      // is never sent again automatically.
      const recoveredAt = new Date();
      await this.prisma.$transaction([
        this.prisma.didiStoreBindingExecutionItem.updateMany({
          where: { executionId: execution.id, status: DidiStoreBindingItemStatus.processing },
          data: { status: DidiStoreBindingItemStatus.pending, message: null, startedAt: null },
        }),
        this.prisma.didiStoreBindingExecutionItem.updateMany({
          where: { executionId: execution.id, status: DidiStoreBindingItemStatus.submitting },
          data: {
            status: DidiStoreBindingItemStatus.unconfirmed,
            message: 'Submission was interrupted. Verify the remote state before retrying.',
            finishedAt: recoveredAt,
          },
        }),
      ]);
      const recovered = await this.executions.recalculate(execution.id);
      if (!isActiveExecution(recovered.status)) return;
      if (recovered.unconfirmedShops > 0) {
        await this.stopSafeRemaining(
          execution.id,
          'Execution stopped after recovering an unconfirmed submission; verify remote state before retrying',
        );
        return;
      }
      if (recovered.cancelRequested) {
        await this.executions.cancelRemaining(execution.id);
        return;
      }

      const environment = execution.environment === DidiBindingEnvironment.PRODUCTION ? 'production' : 'test';
      try {
        await this.bindings.assertDurableRuntimeAllowed(
          execution.applicationId,
          execution.action,
          environment,
          execution.applicationSnapshotFingerprint,
        );
      } catch (error) {
        await this.failSafeItems(execution.id, (error as Error).message);
        return;
      }

      await this.prisma.didiStoreBindingExecution.update({
        where: { id: execution.id },
        data: {
          status: AutoOpenStatus.running,
          startedAt: execution.startedAt ?? new Date(),
          errorMessage: null,
        },
      });

      try {
        if (execution.action === DidiStoreBindingAction.bind) {
          await this.processBind(execution.id, execution.applicationId, environment, execution.applicationSnapshotFingerprint);
        } else {
          await this.processUnbind(execution.id, execution.applicationId, environment, execution.applicationSnapshotFingerprint);
        }
        await this.executions.recalculate(execution.id);
      } catch (error) {
        const message = redactSensitiveText((error as Error).message);
        const now = new Date();
        await this.prisma.$transaction([
          this.prisma.didiStoreBindingExecutionItem.updateMany({
            where: { executionId: execution.id, status: DidiStoreBindingItemStatus.processing },
            data: { status: DidiStoreBindingItemStatus.failed, message, finishedAt: now },
          }),
          this.prisma.didiStoreBindingExecutionItem.updateMany({
            where: { executionId: execution.id, status: DidiStoreBindingItemStatus.submitting },
            data: {
              status: DidiStoreBindingItemStatus.unconfirmed,
              message: `${message}. Verify the remote state before retrying.`,
              finishedAt: now,
            },
          }),
          this.prisma.didiStoreBindingExecution.update({
            where: { id: execution.id },
            data: { errorMessage: message },
          }),
        ]);
        await this.executions.recalculate(execution.id);
        throw error;
      }
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ExecutionJob> | undefined, error: Error) {
    this.logger.error(`DiDi binding execution ${job?.data.executionId ?? 'unknown'} failed: ${redactSensitiveText(error.message)}`);
    if (!job) return;
    const allowedAttempts = job.opts.attempts ?? 1;
    let terminalBullState = false;
    if (typeof job.getState === 'function') {
      terminalBullState = await job.getState()
        .then(state => state === 'failed')
        .catch(() => false);
    }
    // Stalled jobs can be failed by BullMQ with UnrecoverableError before
    // attemptsMade reaches opts.attempts. In either terminal case, close every
    // safe item and preserve submitted items as unconfirmed so the DB cannot
    // remain active without a live queue job.
    if (error.name === 'UnrecoverableError' || terminalBullState || job.attemptsMade >= allowedAttempts) {
      const terminalReason = error.name === 'UnrecoverableError'
        ? `Worker job became unrecoverable: ${error.message}`
        : `Worker exhausted ${allowedAttempts} safe attempts: ${error.message}`;
      await this.failSafeItems(job.data.executionId, terminalReason);
    }
  }

  private async processBind(
    executionId: string,
    applicationId: string,
    environment: 'test' | 'production',
    applicationSnapshotFingerprint: string,
  ) {
    let consecutiveFailedBatches = 0;
    while (true) {
      if (await this.cancelIfRequested(executionId)) return;
      const items = await this.prisma.didiStoreBindingExecutionItem.findMany({
        where: { executionId, status: DidiStoreBindingItemStatus.pending },
        orderBy: { ordinal: 'asc' },
        take: 50,
      });
      if (!items.length) return;
      // Ordinal is immutable, so progress remains stable after a worker restart.
      const batchNo = Math.floor((items[0].ordinal - 1) / 50) + 1;
      const ids = items.map(item => item.id);
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.didiStoreBindingExecutionItem.updateMany({
          where: { id: { in: ids }, status: DidiStoreBindingItemStatus.pending },
          data: { status: DidiStoreBindingItemStatus.processing, startedAt: now, message: null },
        }),
        this.prisma.didiStoreBindingExecution.update({
          where: { id: executionId },
          data: { currentBatch: batchNo, currentShopId: items[0].shopId },
        }),
      ]);

      let results: DidiBindingResult[];
      try {
        results = await this.bindings.executeDurableBindBatch(
          applicationId,
          items.map(item => ({ shopId: item.shopId, appShopId: item.appShopId })),
          environment,
          applicationSnapshotFingerprint,
          async () => {
            const submitted = await this.prisma.didiStoreBindingExecutionItem.updateMany({
              where: { id: { in: ids }, status: DidiStoreBindingItemStatus.processing },
              data: { status: DidiStoreBindingItemStatus.submitting },
            });
            if (submitted.count !== ids.length) throw new Error('Could not persist the Bind submission boundary');
          },
        );
      } catch (error) {
        await this.markItems(ids, DidiStoreBindingItemStatus.processing, 'failed', (error as Error).message);
        await this.executions.recalculate(executionId);
        consecutiveFailedBatches += 1;
        if (consecutiveFailedBatches >= 3) {
          await this.stopSafeRemaining(
            executionId,
            'Execution stopped after 3 consecutive Bind batches failed before submission',
          );
          return;
        }
        continue;
      }
      await this.persistResults(items, results);
      await this.finalizeDanglingBoundaries(ids);
      await this.executions.recalculate(executionId);
      if (results.some(result => /errno=10005/i.test(result.reason ?? ''))) {
        await this.stopSafeRemaining(
          executionId,
          'Execution stopped after DiDi rate limiting persisted through bounded Bind retries',
        );
        return;
      }
      if (results.some(result => result.status === 'unconfirmed')) {
        await this.stopSafeRemaining(
          executionId,
          'Execution stopped after an unconfirmed Bind batch; verify remote state before retrying',
        );
        return;
      }
      consecutiveFailedBatches = results.some(result => result.status === 'success')
        ? 0
        : consecutiveFailedBatches + 1;
      if (consecutiveFailedBatches >= 3) {
        await this.stopSafeRemaining(
          executionId,
          'Execution stopped after 3 consecutive Bind batches without a successful store',
        );
        return;
      }
      const remaining = await this.prisma.didiStoreBindingExecutionItem.count({
        where: { executionId, status: DidiStoreBindingItemStatus.pending },
      });
      if (remaining > 0) {
        if (await this.cancelIfRequested(executionId)) return;
        await sleep(this.batchCooldownMs);
      }
    }
  }

  private async processUnbind(
    executionId: string,
    applicationId: string,
    environment: 'test' | 'production',
    applicationSnapshotFingerprint: string,
  ) {
    let consecutivePreSubmitFailures = 0;
    const pageRows = await this.prisma.didiStoreBindingExecutionItem.findMany({
      // Keep the complete original page sequence so currentBatch does not reset
      // to 1 when a worker resumes after higher pages were already processed.
      where: { executionId },
      select: { remotePageNo: true },
      distinct: ['remotePageNo'],
      orderBy: { remotePageNo: 'desc' },
    });
    const pages = pageRows
      .map(row => row.remotePageNo)
      .filter((page): page is number => typeof page === 'number')
      .sort((left, right) => right - left);

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      if (await this.cancelIfRequested(executionId)) return;
      const pageNo = pages[pageIndex];
      const items = await this.prisma.didiStoreBindingExecutionItem.findMany({
        where: { executionId, remotePageNo: pageNo, status: DidiStoreBindingItemStatus.pending },
        orderBy: { ordinal: 'asc' },
      });
      if (!items.length) continue;
      const ids = items.map(item => item.id);
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.didiStoreBindingExecutionItem.updateMany({
          where: { id: { in: ids }, status: DidiStoreBindingItemStatus.pending },
          data: { status: DidiStoreBindingItemStatus.processing, startedAt: now, message: null },
        }),
        this.prisma.didiStoreBindingExecution.update({
          where: { id: executionId },
          data: { currentBatch: pageIndex + 1, currentShopId: items[0].shopId },
        }),
      ]);

      let verified: Awaited<ReturnType<DidiStoreBindingsService['verifyDurableUnbindPage']>>;
      try {
        // The page is fetched immediately before this page's group. Descending
        // order prevents removals on low pages from shifting targets on high pages.
        verified = await this.bindings.verifyDurableUnbindPage(
          applicationId,
          items.map(item => ({ shopId: item.shopId, appShopId: item.appShopId })),
          pageNo,
          environment,
          applicationSnapshotFingerprint,
        );
      } catch (error) {
        await this.markItems(ids, DidiStoreBindingItemStatus.processing, 'failed', (error as Error).message);
        await this.executions.recalculate(executionId);
        consecutivePreSubmitFailures += items.length;
        if (consecutivePreSubmitFailures >= 10) {
          await this.stopSafeRemaining(
            executionId,
            'Execution stopped after 10 consecutive Unbind failures before submission',
          );
          return;
        }
        continue;
      }

      const itemByPair = new Map(items.map(item => [`${item.shopId}\u0000${item.appShopId}`, item]));
      for (const failure of verified.failures) {
        const item = itemByPair.get(`${failure.shopId}\u0000${failure.appShopId}`);
        if (item) {
          await this.markItems([item.id], DidiStoreBindingItemStatus.processing, 'failed', failure.reason);
        }
      }

      for (const shop of verified.shops) {
        if (await this.cancelIfRequested(executionId)) return;
        const item = itemByPair.get(`${shop.shopId}\u0000${shop.appShopId}`);
        if (!item) continue;
        let result: DidiBindingResult;
        try {
          result = await this.bindings.executeDurableUnbindItem(
            applicationId,
            shop,
            environment,
            applicationSnapshotFingerprint,
            async () => {
              const submitted = await this.prisma.didiStoreBindingExecutionItem.updateMany({
                where: { id: item.id, status: DidiStoreBindingItemStatus.processing },
                data: { status: DidiStoreBindingItemStatus.submitting },
              });
              if (submitted.count !== 1) throw new Error('Could not persist the Unbind submission boundary');
            },
          );
        } catch (error) {
          await this.markItems([item.id], DidiStoreBindingItemStatus.processing, 'failed', (error as Error).message);
          consecutivePreSubmitFailures += 1;
          if (consecutivePreSubmitFailures >= 10) {
            await this.stopSafeRemaining(
              executionId,
              'Execution stopped after 10 consecutive Unbind failures before submission',
            );
            return;
          }
          continue;
        }
        await this.persistResults([item], [result]);
        await this.finalizeDanglingBoundaries([item.id]);
        await this.executions.recalculate(executionId);
        if (/errno=10005/i.test(result.reason ?? '')) {
          await this.stopSafeRemaining(
            executionId,
            'Execution stopped after DiDi rate limiting; no ambiguous Unbind was retried',
          );
          return;
        }
        if (result.status === 'unconfirmed') {
          await this.stopSafeRemaining(
            executionId,
            'Execution stopped after an unconfirmed Unbind; verify remote state before retrying',
          );
          return;
        }
        if (result.status === 'success' || result.submissionStarted) {
          consecutivePreSubmitFailures = 0;
        } else {
          consecutivePreSubmitFailures += 1;
          if (consecutivePreSubmitFailures >= 10) {
            await this.stopSafeRemaining(
              executionId,
              'Execution stopped after 10 consecutive Unbind failures before submission',
            );
            return;
          }
        }
      }

      await this.markItems(
        ids,
        DidiStoreBindingItemStatus.processing,
        'failed',
        'Store was not eligible after fresh DiDi page verification',
      );
      await this.executions.recalculate(executionId);
      if (pageIndex + 1 < pages.length) {
        if (await this.cancelIfRequested(executionId)) return;
        await sleep(this.pageCooldownMs);
      }
    }
  }

  private async persistResults(
    items: Array<{ id: string; shopId: string; appShopId: string }>,
    results: DidiBindingResult[],
  ) {
    const resultByPair = new Map(results.map(result => [`${result.shopId}\u0000${result.appShopId}`, result]));
    const now = new Date();
    await this.prisma.$transaction(items.map(item => {
      const result = resultByPair.get(`${item.shopId}\u0000${item.appShopId}`) ?? {
        status: 'unconfirmed' as const,
        reason: 'Provider omitted the item result. Verify the remote state before retrying.',
      };
      return this.prisma.didiStoreBindingExecutionItem.updateMany({
        where: { id: item.id, status: DidiStoreBindingItemStatus.submitting },
        data: {
          status: result.status === 'success'
            ? DidiStoreBindingItemStatus.success
            : result.status === 'failed'
              ? DidiStoreBindingItemStatus.failed
              : DidiStoreBindingItemStatus.unconfirmed,
          message: result.reason ? redactSensitiveText(result.reason) : null,
          finishedAt: now,
        },
      });
    }));
  }

  private async markItems(
    ids: string[],
    from: DidiStoreBindingItemStatus,
    to: 'failed' | 'unconfirmed',
    rawMessage: unknown,
  ) {
    if (!ids.length) return;
    await this.prisma.didiStoreBindingExecutionItem.updateMany({
      where: { id: { in: ids }, status: from },
      data: {
        status: to === 'failed' ? DidiStoreBindingItemStatus.failed : DidiStoreBindingItemStatus.unconfirmed,
        message: redactSensitiveText(rawMessage),
        finishedAt: new Date(),
      },
    });
  }

  private async finalizeDanglingBoundaries(ids: string[]) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.didiStoreBindingExecutionItem.updateMany({
        where: { id: { in: ids }, status: DidiStoreBindingItemStatus.processing },
        data: {
          status: DidiStoreBindingItemStatus.failed,
          message: 'Submission boundary was not reached',
          finishedAt: now,
        },
      }),
      this.prisma.didiStoreBindingExecutionItem.updateMany({
        where: { id: { in: ids }, status: DidiStoreBindingItemStatus.submitting },
        data: {
          status: DidiStoreBindingItemStatus.unconfirmed,
          message: 'Submission result could not be persisted. Verify the remote state before retrying.',
          finishedAt: now,
        },
      }),
    ]);
  }

  private async stopSafeRemaining(executionId: string, rawMessage: string) {
    const message = redactSensitiveText(rawMessage);
    await this.prisma.didiStoreBindingExecutionItem.updateMany({
      where: {
        executionId,
        status: { in: [
          DidiStoreBindingItemStatus.pending,
          DidiStoreBindingItemStatus.processing,
        ] },
      },
      data: { status: DidiStoreBindingItemStatus.failed, message, finishedAt: new Date() },
    });
    await this.prisma.didiStoreBindingExecution.update({
      where: { id: executionId },
      data: { errorMessage: message },
    });
    await this.executions.recalculate(executionId);
  }

  private async cancelIfRequested(executionId: string) {
    const execution = await this.prisma.didiStoreBindingExecution.findUnique({
      where: { id: executionId },
      select: { cancelRequested: true },
    });
    if (!execution?.cancelRequested) return false;
    await this.executions.cancelRemaining(executionId);
    return true;
  }

  private async failSafeItems(executionId: string, rawMessage: unknown) {
    const message = redactSensitiveText(rawMessage);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.didiStoreBindingExecutionItem.updateMany({
        where: { executionId, status: { in: [
          DidiStoreBindingItemStatus.pending,
          DidiStoreBindingItemStatus.processing,
        ] } },
        data: { status: DidiStoreBindingItemStatus.failed, message, finishedAt: now },
      }),
      this.prisma.didiStoreBindingExecution.update({
        where: { id: executionId },
        data: { errorMessage: message },
      }),
      this.prisma.didiStoreBindingExecutionItem.updateMany({
        where: { executionId, status: DidiStoreBindingItemStatus.submitting },
        data: {
          status: DidiStoreBindingItemStatus.unconfirmed,
          message: `${message}. Verify the remote state before retrying.`,
          finishedAt: now,
        },
      }),
    ]);
    await this.executions.recalculate(executionId);
  }
}
