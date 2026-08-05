import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FileIntegrationKind, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { detectDelimiter, looksLikeCityClub, parseAmount, wildcardToRegExp } from './file-integration.util';
import { SftpConnectionService } from './sftp-connection.service';

class FileIntegrationCancelledError extends Error {}

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
  skipped?: string;
  error?: string;
}

@Injectable()
@Processor('file-integrations', { concurrency: 2 })
export class FileIntegrationProcessor extends WorkerHost {
  private readonly logger = new Logger(FileIntegrationProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly sftp: SftpConnectionService) { super(); }

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

    try {
      await this.sftp.withClient(rule.sftpApplicationId, async (client, rootPath) => {
        await this.ensureActive(executionId);
        const matcher = wildcardToRegExp(rule.filePattern);
        const allFiles = (await client.list(rootPath))
          .filter(file => file.type === '-' && matcher.test(file.name))
          .sort((a, b) => a.modifyTime - b.modifyTime || a.name.localeCompare(b.name));
        filesScanned = allFiles.length;
        const newFiles = rule.lastRemoteModifiedAt
          ? allFiles.filter(file => file.modifyTime > rule.lastRemoteModifiedAt!.getTime())
          : allFiles;
        const candidates = rule.kind === FileIntegrationKind.complex_promotion_reader
          ? newFiles.slice(-Math.min(rule.maxFilesPerRun, 100))
          : newFiles.slice(0, rule.maxFilesPerRun);

        await this.prisma.fileIntegrationExecution.update({
          where: { id: executionId }, data: { filesScanned },
        });
        const outputDir = resolve(process.cwd(), 'uploads', 'integrations', executionId);
        if (rule.kind === FileIntegrationKind.price_filter) await mkdir(outputDir, { recursive: true });

        for (const file of candidates) {
          await this.ensureActive(executionId);
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
            const value = await client.get(remotePath);
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
              continue;
            }

            if (rule.kind === FileIntegrationKind.complex_promotion_reader) {
              base.rowsRead = lines.filter(Boolean).length;
              base.rowsKept = base.rowsRead;
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
            await writeFile(resolve(outputDir, file.name), output, 'utf8');
            base.outputFile = file.name;
            results.push(base);
            filesProcessed++;
            rowsRead += base.rowsRead;
            rowsKept += base.rowsKept;
            rowsRemoved += base.rowsRemoved;
            newestModifiedAt = this.maxDate(newestModifiedAt, modifiedAt);
          } catch (error) {
            base.error = this.safeError(error);
            results.push(base);
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
      await this.prisma.$transaction([
        this.prisma.fileIntegrationExecution.update({
          where: { id: executionId },
          data: {
            status, finishedAt, durationMs: Date.now() - started, filesScanned, filesProcessed,
            rowsRead, rowsKept, rowsRemoved, bytesRead, currentFile: null,
            errorMessage: failed ? `${failed} file(s) failed; see execution details` : null,
            result: { files: results, newFiles: results.length, outputDirectory: rule.kind === 'price_filter' ? executionId : null } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.fileIntegrationRule.update({
          where: { id: rule.id },
          data: { lastRunAt: finishedAt, lastRemoteModifiedAt: newestModifiedAt },
        }),
      ]);
    } catch (error) {
      const cancelled = error instanceof FileIntegrationCancelledError;
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
