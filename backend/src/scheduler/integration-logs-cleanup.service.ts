import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const INTEGRATION_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BATCHES = 100;

@Injectable()
export class IntegrationLogsCleanupService {
  private readonly logger = new Logger(IntegrationLogsCleanupService.name);
  private busy = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 0 3 * * *', { timeZone: 'America/Mexico_City' })
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
        try { this.logger.log(`${name}: ${await operation()} registros eliminados; corte ${cutoff.toISOString()}`); }
        catch (error) { this.logger.error(`${name}: falló la limpieza`, error instanceof Error ? error.stack : undefined); }
      }
    } finally { this.busy = false; }
  }

  private async batches(size: number, operation: (tx: Prisma.TransactionClient) => Promise<number>) {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const count = await this.prisma.$transaction(async tx => {
        // Transaction-scoped PostgreSQL lock coordinates all backend replicas.
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(72612, 1) AS acquired
        `;
        if (!lock.acquired) return 0;
        return operation(tx);
      }, { timeout: 30_000 });
      total += count;
      if (count < size) break;
    }
    return total;
  }

  private cleanupRequests(cutoff: Date) {
    const size = 1000;
    const where: Prisma.DidiOrderWebhookRequestWhereInput = {
      createdAt: { lt: cutoff }, outcome: { not: 'processing' }, completedAt: { not: null },
    };
    return this.batches(size, async tx => {
      const rows = await tx.didiOrderWebhookRequest.findMany({
        where, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: size,
      });
      if (!rows.length) return 0;
      // Events are the confirmation budget / deduplication ledger, not request
      // logs. Keep them so an old webhook cannot confirm an order a third time.
      const result = await tx.didiOrderWebhookRequest.deleteMany({
        where: { ...where, id: { in: rows.map(row => row.id) } },
      });
      return result.count;
    });
  }

  private cleanupSftp(cutoff: Date) {
    const size = 100;
    return this.batches(size, async tx => {
      const rows = await tx.sftpApiRun.findMany({
        where: { createdAt: { lt: cutoff }, finishedAt: { lt: cutoff }, status: { notIn: ['pending', 'running'] } },
        select: { id: true }, orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }], take: size,
      });
      if (!rows.length) return 0;
      const runId = { in: rows.map(row => row.id) };
      // Keep only file identity/state to prevent replay when a rule allows old
      // SFTP files. Remove its audit details and detach it before deleting runs.
      await tx.sftpApiProcessedFile.updateMany({
        where: { runId }, data: { runId: null, fileHash: null, error: null },
      });
      await tx.sftpApiUpload.deleteMany({ where: { runId } });
      const result = await tx.sftpApiRun.deleteMany({ where: { id: runId } });
      return result.count;
    });
  }
}
