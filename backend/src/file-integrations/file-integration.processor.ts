import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileIntegrationKind, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { posix, resolve } from 'path';
import SftpClient = require('ssh2-sftp-client');
import { PrismaService } from '../prisma/prisma.service';
import { detectDelimiter, looksLikeCityClub, parseAmount, wildcardToRegExp } from './file-integration.util';
import { parsePromotionLines, promotionShopIdFromFileName } from './promotion-file.util';
import { SftpConnectionService } from './sftp-connection.service';
import { StorePromotionStorageService } from './store-promotion-storage.service';

class FileIntegrationCancelledError extends Error {}
class SftpOperationTimeoutError extends Error {}

const PROMOTION_SHOPS_PER_RUN_LIMIT = 20;
const FILE_STATE_RETENTION_DAYS = 7;
const FILE_MAX_ATTEMPTS = 3;

interface RemoteFileMetadata {
  name: string;
  size: number;
  modifyTime: number;
}

interface FileResult {
  fileName: string;
  size: number;
  modifiedAt: string;
  rowsRead: number;
  rowsKept: number;
  rowsRemoved: number;
  invalidAmounts: number;
  delimiter: string;
  outputFile?: string;
  beforeFile?: string;
  afterFile?: string;
  backupRemotePath?: string;
  remoteReplaced?: boolean;
  promotionsStored?: number;
  invalidRows?: number;
  skipped?: string;
  error?: string;
}

@Injectable()
@Processor('file-integrations', { concurrency: 2 })
export class FileIntegrationProcessor extends WorkerHost {
  private readonly logger = new Logger(FileIntegrationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sftp: SftpConnectionService,
    private readonly promotionStorage: StorePromotionStorageService,
    private readonly config: ConfigService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const started = Date.now();
    const executionId = job.data.executionId;
    const claimed = await this.prisma.fileIntegrationExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), errorMessage: null },
    });
    if (!claimed.count) return;
    const execution = await this.prisma.fileIntegrationExecution.findUnique({
      where: { id: executionId }, include: { rule: true },
    });
    if (!execution) return;
    const { rule } = execution;

    const results: FileResult[] = [];
    let filesScanned = 0;
    let filesProcessed = 0;
    let rowsRead = 0;
    let rowsKept = 0;
    let rowsRemoved = 0;
    let bytesRead = BigInt(0);
    let newestModifiedAt = rule.lastRemoteModifiedAt;
    let priceScanAt: Date | null = null;

    try {
      await this.sftp.withClient(rule.sftpApplicationId, async (client, rootPath) => {
        await this.ensureActive(executionId);
        const matcher = wildcardToRegExp(rule.filePattern);
        const allFiles = (await this.withSftpTimeout(client, client.list(rootPath), 'SFTP directory listing'))
          .filter(file => file.type === '-' && matcher.test(file.name))
          .sort((a, b) => a.modifyTime - b.modifyTime || a.name.localeCompare(b.name));
        filesScanned = allFiles.length;
        const newFiles = rule.lastRemoteModifiedAt
          ? allFiles.filter(file => file.modifyTime > rule.lastRemoteModifiedAt!.getTime())
          : allFiles;
        const pricePlan = rule.kind === FileIntegrationKind.price_filter
          ? await this.priceFilterCandidates(rule.id, rule.fileStateInitializedAt, allFiles, rule.maxFilesPerRun)
          : null;
        priceScanAt = pricePlan?.scanAt ?? null;
        const candidates = rule.kind === FileIntegrationKind.complex_promotion_reader
          ? await this.promotionCandidates(
              rule.sftpApplicationId,
              allFiles,
              newFiles,
              Math.min(rule.maxFilesPerRun, PROMOTION_SHOPS_PER_RUN_LIMIT),
            )
          : pricePlan!.files;

        await this.prisma.fileIntegrationExecution.update({
          where: { id: executionId }, data: { filesScanned },
        });
        const outputDir = resolve(process.cwd(), 'uploads', 'integrations', executionId);
        if (rule.kind === FileIntegrationKind.price_filter) await mkdir(outputDir, { recursive: true });

        for (const file of candidates) {
          await this.ensureActive(executionId);
          if (rule.kind === FileIntegrationKind.price_filter) {
            const claimedFile = await this.prisma.fileIntegrationFileState.updateMany({
              where: {
                ruleId: rule.id,
                fileName: file.name,
                OR: [{ status: 'pending' }, { status: 'failed', attempts: { lt: FILE_MAX_ATTEMPTS } }],
              },
              data: {
                status: 'running',
                attempts: { increment: 1 },
                processingAt: new Date(),
                lastError: null,
              },
            });
            if (!claimedFile.count) continue;
          }
          await this.prisma.fileIntegrationExecution.update({
            where: { id: executionId }, data: { currentFile: file.name },
          });
          const modifiedAt = new Date(file.modifyTime);
          const base: FileResult = {
            fileName: file.name, size: file.size, modifiedAt: modifiedAt.toISOString(),
            rowsRead: 0, rowsKept: 0, rowsRemoved: 0, invalidAmounts: 0, delimiter: rule.delimiter || 'auto',
          };
          try {
            const remotePath = this.sftp.safeRemotePath(rootPath, file.name);
            const value = await this.withSftpTimeout(
              client,
              client.get(remotePath),
              `download of ${file.name}`,
            );
            await this.ensureActive(executionId);
            const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
            bytesRead += BigInt(buffer.length);
            const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
            const hasTrailingNewline = /\r?\n$/.test(text);
            const lines = text.split(/\r?\n/);
            if (hasTrailingNewline && lines[lines.length - 1] === '') lines.pop();
            const delimiter = detectDelimiter(lines[0] ?? '', rule.delimiter);
            base.delimiter = delimiter === '\t' ? '\\t' : delimiter;

            if (rule.sourceScope === 'city_club' && !looksLikeCityClub(file.name, lines)) {
              base.skipped = 'File does not belong to City Club';
              results.push(base);
              newestModifiedAt = this.maxDate(newestModifiedAt, modifiedAt);
              if (rule.kind === FileIntegrationKind.price_filter) {
                await this.markFileDone(rule.id, file.name, modifiedAt, file.size);
              }
              continue;
            }

            if (rule.kind === FileIntegrationKind.complex_promotion_reader) {
              const parsed = parsePromotionLines(lines, delimiter);
              const fileShopId = promotionShopIdFromFileName(file.name);
              const groups = new Map<string, typeof parsed.rows>();
              for (const row of parsed.rows) {
                const group = groups.get(row.shopExternalId) ?? [];
                group.push(row);
                groups.set(row.shopExternalId, group);
              }
              if (groups.size === 0 && fileShopId) groups.set(fileShopId, []);
              for (const [shopExternalId, values] of groups) {
                await this.promotionStorage.replace(
                  rule.sftpApplicationId,
                  shopExternalId,
                  file.name,
                  modifiedAt,
                  values,
                );
              }
              base.rowsRead = parsed.rows.length + parsed.invalidRows;
              base.rowsKept = parsed.rows.length;
              base.invalidRows = parsed.invalidRows;
              base.promotionsStored = parsed.rows.length;
              results.push(base);
              filesProcessed++;
              rowsRead += base.rowsRead;
              rowsKept += base.rowsKept;
              newestModifiedAt = this.maxDate(newestModifiedAt, modifiedAt);
              continue;
            }

            if (rule.priceColumn === null || rule.thresholdAmount === null) throw new Error('Price filter is missing its column or threshold');
            const kept: string[] = [];
            const threshold = Number(rule.thresholdAmount);
            for (const line of lines) {
              if (!line.trim()) { kept.push(line); continue; }
              base.rowsRead++;
              const columns = line.split(delimiter);
              const amount = parseAmount(columns[rule.priceColumn] ?? '');
              if (amount === null) {
                base.invalidAmounts++;
                base.rowsKept++;
                kept.push(line);
              } else if (amount > threshold) {
                base.rowsRemoved++;
              } else {
                base.rowsKept++;
                kept.push(line);
              }
            }
            const output = `${kept.join('\n')}${hasTrailingNewline ? '\n' : ''}`;
            const beforeName = `before__${file.name}`;
            const afterName = `after__${file.name}`;
            await writeFile(resolve(outputDir, beforeName), buffer);
            await writeFile(resolve(outputDir, afterName), output, 'utf8');
            base.beforeFile = beforeName;
            base.afterFile = afterName;
            base.outputFile = afterName;
            if (base.rowsRemoved > 0) {
              await this.ensureActive(executionId);
              const replacement = await this.replaceRemoteFile(
                client,
                rootPath,
                file.name,
                Buffer.from(output, 'utf8'),
                executionId,
              );
              base.remoteReplaced = true;
              base.backupRemotePath = replacement.backupPath;
              newestModifiedAt = this.maxDate(newestModifiedAt, replacement.modifiedAt);
              await this.markFileDone(rule.id, file.name, replacement.modifiedAt, replacement.size);
            } else {
              base.remoteReplaced = false;
              newestModifiedAt = this.maxDate(newestModifiedAt, modifiedAt);
              await this.markFileDone(rule.id, file.name, modifiedAt, file.size);
            }
            results.push(base);
            filesProcessed++;
            rowsRead += base.rowsRead;
            rowsKept += base.rowsKept;
            rowsRemoved += base.rowsRemoved;
          } catch (error) {
            if (error instanceof FileIntegrationCancelledError || error instanceof SftpOperationTimeoutError) throw error;
            base.error = this.safeError(error);
            results.push(base);
            if (rule.kind === FileIntegrationKind.price_filter) {
              await this.markFileFailed(rule.id, file.name, base.error);
            }
            this.logger.warn(`File integration ${executionId} failed for ${file.name}: ${base.error}`);
          }
          await this.prisma.fileIntegrationExecution.update({
            where: { id: executionId },
            data: { filesProcessed, rowsRead, rowsKept, rowsRemoved, bytesRead },
          });
        }
      });

      const failed = results.filter(value => value.error).length;
      const status = failed === 0 ? 'done' : filesProcessed > 0 ? 'partial_success' : 'failed';
      const finishedAt = new Date();
      const remainingPending = rule.kind === FileIntegrationKind.price_filter && priceScanAt
        ? await this.prisma.fileIntegrationFileState.count({
            where: { ruleId: rule.id, status: 'pending', lastSeenAt: priceScanAt },
          })
        : 0;
      await this.prisma.$transaction([
        this.prisma.fileIntegrationExecution.update({
          where: { id: executionId },
          data: {
            status, finishedAt, durationMs: Date.now() - started, filesScanned, filesProcessed,
            rowsRead, rowsKept, rowsRemoved, bytesRead, currentFile: null,
            errorMessage: failed ? `${failed} file(s) failed; see execution details` : null,
            result: {
              files: results,
              newFiles: results.length,
              pendingFiles: remainingPending,
              outputDirectory: rule.kind === 'price_filter' ? executionId : null,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.fileIntegrationRule.update({
          where: { id: rule.id },
          data: {
            lastRunAt: finishedAt,
            lastRemoteModifiedAt: newestModifiedAt,
            nextRunAt: remainingPending > 0 && rule.active
              ? new Date(finishedAt.getTime() + 60_000)
              : undefined,
          },
        }),
      ]);
    } catch (error) {
      const cancelled = error instanceof FileIntegrationCancelledError;
      if (rule.kind === FileIntegrationKind.price_filter) {
        await this.prisma.fileIntegrationFileState.updateMany({
          where: { ruleId: rule.id, status: 'running' },
          data: {
            status: cancelled ? 'pending' : 'failed',
            processingAt: null,
            lastError: cancelled ? null : this.safeError(error),
          },
        });
      }
      await this.prisma.fileIntegrationExecution.updateMany({
        where: { id: executionId, status: 'running' },
        data: {
          status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date(), durationMs: Date.now() - started,
          filesScanned, filesProcessed, rowsRead, rowsKept, rowsRemoved, bytesRead, currentFile: null,
          errorMessage: cancelled ? 'Stopped manually' : this.safeError(error),
          result: { files: results } as unknown as Prisma.InputJsonValue,
        },
      });
      if (!cancelled) throw error;
    }
  }

  private async priceFilterCandidates(
    ruleId: string,
    initializedAt: Date | null,
    allFiles: RemoteFileMetadata[],
    limit: number,
  ) {
    const scanAt = new Date();
    const existing = await this.prisma.fileIntegrationFileState.findMany({
      where: { ruleId },
      select: { fileName: true, sourceModifiedAt: true, fileSize: true, status: true },
    });
    const existingByName = new Map(existing.map(value => [value.fileName, value]));
    const historicallyProcessed = initializedAt
      ? new Set<string>()
      : await this.historicallyProcessedFileNames(ruleId);
    const newFiles = allFiles.filter(file => !existingByName.has(file.name));

    for (let offset = 0; offset < newFiles.length; offset += 1_000) {
      await this.prisma.fileIntegrationFileState.createMany({
        data: newFiles.slice(offset, offset + 1_000).map(file => {
          const done = historicallyProcessed.has(file.name);
          return {
            ruleId,
            fileName: file.name,
            sourceModifiedAt: new Date(file.modifyTime),
            fileSize: BigInt(file.size),
            status: done ? 'done' : 'pending',
            attempts: done ? 1 : 0,
            firstSeenAt: scanAt,
            lastSeenAt: scanAt,
            processedAt: done ? scanAt : null,
          };
        }),
        skipDuplicates: true,
      });
    }

    for (let offset = 0; offset < allFiles.length; offset += 1_000) {
      await this.prisma.fileIntegrationFileState.updateMany({
        where: { ruleId, fileName: { in: allFiles.slice(offset, offset + 1_000).map(file => file.name) } },
        data: { lastSeenAt: scanAt },
      });
    }

    const changedFiles = allFiles.filter(file => {
      const current = existingByName.get(file.name);
      return current && (
        current.sourceModifiedAt.getTime() !== file.modifyTime
        || current.fileSize !== BigInt(file.size)
      );
    });
    for (let offset = 0; offset < changedFiles.length; offset += 500) {
      await this.prisma.$transaction(changedFiles.slice(offset, offset + 500).map(file => (
        this.prisma.fileIntegrationFileState.update({
          where: { ruleId_fileName: { ruleId, fileName: file.name } },
          data: {
            sourceModifiedAt: new Date(file.modifyTime),
            fileSize: BigInt(file.size),
            status: 'pending',
            attempts: 0,
            lastError: null,
            processingAt: null,
            processedAt: null,
            lastSeenAt: scanAt,
          },
        })
      )));
    }

    if (!initializedAt) {
      await this.prisma.fileIntegrationRule.update({
        where: { id: ruleId },
        data: { fileStateInitializedAt: scanAt },
      });
    }
    const retentionCutoff = new Date(scanAt.getTime() - FILE_STATE_RETENTION_DAYS * 86_400_000);
    await this.prisma.fileIntegrationFileState.deleteMany({
      where: { ruleId, status: 'done', lastSeenAt: { lt: retentionCutoff } },
    });

    const states = await this.prisma.fileIntegrationFileState.findMany({
      where: {
        ruleId,
        lastSeenAt: scanAt,
        OR: [
          { status: 'pending' },
          { status: 'failed', attempts: { lt: FILE_MAX_ATTEMPTS } },
        ],
      },
      orderBy: [{ sourceModifiedAt: 'asc' }, { fileName: 'asc' }],
      take: limit,
      select: { fileName: true },
    });
    const remoteByName = new Map(allFiles.map(file => [file.name, file]));
    return {
      scanAt,
      files: states.flatMap(state => {
        const file = remoteByName.get(state.fileName);
        return file ? [file] : [];
      }),
    };
  }

  private async historicallyProcessedFileNames(ruleId: string) {
    const executions = await this.prisma.fileIntegrationExecution.findMany({
      where: { ruleId, result: { not: Prisma.JsonNull } },
      select: { result: true },
    });
    const names = new Set<string>();
    for (const execution of executions) {
      const result = execution.result as { files?: Array<{ fileName?: unknown; error?: unknown }> } | null;
      for (const file of result?.files ?? []) {
        if (typeof file.fileName === 'string' && !file.error) names.add(file.fileName);
      }
    }
    return names;
  }

  private async markFileDone(ruleId: string, fileName: string, modifiedAt: Date, size: number) {
    await this.prisma.fileIntegrationFileState.updateMany({
      where: { ruleId, fileName },
      data: {
        sourceModifiedAt: modifiedAt,
        fileSize: BigInt(size),
        status: 'done',
        lastError: null,
        processingAt: null,
        processedAt: new Date(),
      },
    });
  }

  private async markFileFailed(ruleId: string, fileName: string, error: string) {
    await this.prisma.fileIntegrationFileState.updateMany({
      where: { ruleId, fileName },
      data: { status: 'failed', lastError: error, processingAt: null },
    });
  }

  private async promotionCandidates<T extends { name: string; modifyTime: number }>(
    sftpApplicationId: string,
    allFiles: T[],
    unrecognizedFallback: T[],
    limit: number,
  ) {
    const latestByShop = new Map<string, T>();
    for (const file of allFiles) {
      const shopId = promotionShopIdFromFileName(file.name);
      if (!shopId) continue;
      const current = latestByShop.get(shopId);
      if (!current || file.modifyTime > current.modifyTime || (file.modifyTime === current.modifyTime && file.name > current.name)) {
        latestByShop.set(shopId, file);
      }
    }
    const snapshots = await this.prisma.promotionShopSnapshot.findMany({
      where: { sftpApplicationId },
      select: { shopExternalId: true, sourceFile: true, sourceModifiedAt: true },
    });
    const snapshotByShop = new Map(snapshots.map(value => [value.shopExternalId, value]));
    const recognized = [...latestByShop.entries()]
      .filter(([shopId, file]) => {
        const snapshot = snapshotByShop.get(shopId);
        return !snapshot || snapshot.sourceFile !== file.name || snapshot.sourceModifiedAt.getTime() < file.modifyTime;
      })
      .map(([, file]) => file);
    const unrecognized = unrecognizedFallback.filter(file => !promotionShopIdFromFileName(file.name));
    return [...recognized, ...unrecognized]
      .sort((left, right) => left.modifyTime - right.modifyTime || left.name.localeCompare(right.name))
      .slice(0, limit);
  }

  private async replaceRemoteFile(
    client: SftpClient,
    rootPath: string,
    fileName: string,
    filtered: Buffer,
    executionId: string,
  ) {
    if (this.config.get('FILE_INTEGRATIONS_REMOTE_WRITE_ENABLED', 'false') !== 'true') {
      throw new Error('Remote replacement is disabled in this environment');
    }
    const remotePath = this.sftp.safeRemotePath(rootPath, fileName);
    const backupDirectory = posix.join(rootPath, '.tequila-backup', executionId);
    const backupPath = posix.join(backupDirectory, fileName);
    const temporaryPath = posix.join(rootPath, `.${fileName}.${executionId}.tmp`);
    await this.withSftpTimeout(client, client.mkdir(backupDirectory, true), `creation of ${backupDirectory}`);
    await this.withSftpTimeout(client, client.put(filtered, temporaryPath), `upload of ${fileName}`);
    const verification = await this.withSftpTimeout(
      client,
      client.get(temporaryPath),
      `verification download of ${fileName}`,
    );
    const verifiedBuffer = Buffer.isBuffer(verification) ? verification : Buffer.from(String(verification));
    if (this.sha256(filtered) !== this.sha256(verifiedBuffer)) {
      await client.delete(temporaryPath).catch(() => false);
      throw new Error('Remote temporary file verification failed; original file was not changed');
    }
    await this.ensureActive(executionId);
    // Do not interrupt the two renames: once the original moves to backup this
    // critical section must either finish the replacement or restore it.
    await client.rename(remotePath, backupPath);
    try {
      await client.rename(temporaryPath, remotePath);
    } catch (error) {
      await client.rename(backupPath, remotePath).catch(() => false);
      await client.delete(temporaryPath).catch(() => false);
      throw error;
    }
    const stat = await client.stat(remotePath);
    return { backupPath, modifiedAt: new Date(stat.modifyTime), size: Number(stat.size) };
  }

  private async withSftpTimeout<T>(client: SftpClient, operation: Promise<T>, label: string): Promise<T> {
    const configured = Number(this.config.get('FILE_INTEGRATIONS_SFTP_OPERATION_TIMEOUT_MS', '60000'));
    const timeoutMs = Number.isFinite(configured) ? Math.min(Math.max(configured, 10_000), 600_000) : 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void client.end().catch(() => false);
        reject(new SftpOperationTimeoutError(`${label} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sha256(value: Buffer) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async ensureActive(id: string) {
    const execution = await this.prisma.fileIntegrationExecution.findUnique({
      where: { id }, select: { status: true, cancelRequested: true },
    });
    if (execution?.status !== 'running' || execution.cancelRequested) throw new FileIntegrationCancelledError();
  }

  private maxDate(current: Date | null, candidate: Date) {
    return !current || candidate > current ? candidate : current;
  }

  private safeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/password\s*[=:]\s*[^\s,;]+/gi, 'credential=<redacted>').slice(0, 1000);
  }

  @OnWorkerEvent('failed')
  async failed(job: Job<{ executionId: string }> | undefined, error: Error) {
    if (!job?.data.executionId) return;
    await this.prisma.fileIntegrationExecution.updateMany({
      where: { id: job.data.executionId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: this.safeError(error), currentFile: null },
    });
  }
}
