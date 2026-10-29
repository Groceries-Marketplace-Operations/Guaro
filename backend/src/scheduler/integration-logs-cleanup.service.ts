import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const INTEGRATION_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BATCHES = 100;
const MAX_PASS_MS = 60_000;
export const INTEGRATION_LOG_CLEANUP_CRON = '0 */10 3-5 * * *';
export const SFTP_UPLOAD_CLEANUP_BATCH_SIZE = 25;
const SFTP_FILE_BATCH_SIZE = 100;

interface BatchProgress {
  deleted: number;
  uploads?: number;
  files?: number;
  more: boolean;
}

@Injectable()
export class IntegrationLogsCleanupService {
  private readonly logger = new Logger(IntegrationLogsCleanupService.name);
  private busy = false;

  constructor(private readonly prisma: PrismaService) {}

  // Start at 03:00, then resume bounded work through 05:50 Mexico City time.
  @Cron(INTEGRATION_LOG_CLEANUP_CRON, { timeZone: 'America/Mexico_City' })
  async cleanup() {
    if (this.busy) return;
    this.busy = true;
    const cutoff = new Date(Date.now() - INTEGRATION_LOG_RETENTION_MS);
    try {
      // Independent jobs: an error cleaning one history must not block the other.
      for (const [name, operation] of [
        ['Order webhooks logs', () => this.cleanupRequests(cutoff)],
        ['SFTP to API', () => this.cleanupSftp(cutoff)],
      ] as const) {
        try {
          const result = await operation();
          this.logger.log(`${name}: ${result.deleted} registros eliminados; ${result.uploads} envíos eliminados; ${result.files} archivos compactados; ${result.batches} lotes confirmados; fin=${result.reason}; corte ${cutoff.toISOString()}`);
        }
        catch (error) { this.logger.error(`${name}: falló la limpieza`, error instanceof Error ? error.stack : undefined); }
      }
    } finally { this.busy = false; }
  }

  private async batches(operation: (tx: Prisma.TransactionClient) => Promise<BatchProgress>) {
    const total = { deleted: 0, uploads: 0, files: 0, batches: 0, reason: 'limite_de_lotes' };
    const startedAt = Date.now();
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      if (Date.now() - startedAt >= MAX_PASS_MS) { total.reason = 'limite_de_tiempo'; break; }
      const progress = await this.prisma.$transaction(async tx => {
        // Transaction-scoped PostgreSQL lock coordinates all backend replicas.
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(72612, 1) AS acquired
        `;
        if (!lock.acquired) return null;
        return operation(tx);
      }, { timeout: 30_000 }).catch(error => {
        this.logger.log(`Avance confirmado antes del error: ${total.deleted} registros, ${total.uploads} envíos, ${total.files} archivos, ${total.batches} lotes`);
        throw error;
      });
      if (!progress) { total.reason = 'bloqueo_ocupado'; break; }
      total.deleted += progress.deleted;
      total.uploads += progress.uploads ?? 0;
      total.files += progress.files ?? 0;
      total.batches++;
      if (!progress.more) { total.reason = 'sin_pendientes'; break; }
    }
    return total;
  }

  private cleanupRequests(cutoff: Date) {
    const size = 1000;
    const where: Prisma.DidiOrderWebhookRequestWhereInput = {
      createdAt: { lt: cutoff }, outcome: { not: 'processing' }, completedAt: { not: null },
    };
    return this.batches(async tx => {
      const rows = await tx.didiOrderWebhookRequest.findMany({
        where, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: size,
      });
      if (!rows.length) return { deleted: 0, more: false };
      // Events are the confirmation budget / deduplication ledger, not request
      // logs. Keep them so an old webhook cannot confirm an order a third time.
      const result = await tx.didiOrderWebhookRequest.deleteMany({
        where: { ...where, id: { in: rows.map(row => row.id) } },
      });
      return { deleted: result.count, more: rows.length === size };
    });
  }

  private cleanupSftp(cutoff: Date) {
    return this.batches(async tx => {
      // A run can contain thousands of large payloads. Bound the child rows,
      // not just the number of parent runs, and commit each chunk independently.
      const rows = await tx.sftpApiRun.findMany({
        where: { createdAt: { lt: cutoff }, finishedAt: { lt: cutoff }, status: { notIn: ['pending', 'running'] } },
        select: { id: true }, orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }], take: 1,
      });
      if (!rows.length) return { deleted: 0, more: false };
      const runId = rows[0].id;
      // Keep only file identity/state to prevent replay when a rule allows old
      // SFTP files. Remove its audit details and detach it before deleting runs.
      const files = await tx.sftpApiProcessedFile.findMany({
        where: { runId }, select: { id: true }, take: SFTP_FILE_BATCH_SIZE,
      });
      if (files.length) await tx.sftpApiProcessedFile.updateMany({
        where: { runId, id: { in: files.map(row => row.id) } }, data: { runId: null, fileHash: null, error: null },
      });
      const uploads = await tx.sftpApiUpload.findMany({
        where: { runId }, select: { id: true }, take: SFTP_UPLOAD_CLEANUP_BATCH_SIZE,
      });
      if (uploads.length) await tx.sftpApiUpload.deleteMany({ where: { runId, id: { in: uploads.map(row => row.id) } } });
      // A full chunk may leave children. Revisit the run in the next transaction
      // instead of performing a large cascade or rolling back earlier progress.
      if (files.length === SFTP_FILE_BATCH_SIZE || uploads.length === SFTP_UPLOAD_CLEANUP_BATCH_SIZE) {
        return { deleted: 0, uploads: uploads.length, files: files.length, more: true };
      }
      const result = await tx.sftpApiRun.deleteMany({ where: {
        id: runId, createdAt: { lt: cutoff }, finishedAt: { lt: cutoff }, status: { notIn: ['pending', 'running'] },
      } });
      return { deleted: result.count, uploads: uploads.length, files: files.length, more: true };
    });
  }
}
