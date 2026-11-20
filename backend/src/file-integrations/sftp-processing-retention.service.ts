import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileIntegrationKind } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { rm } from 'fs/promises';
import { posix, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SftpConnectionService } from './sftp-connection.service';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EXECUTIONS_PER_PASS = 50;

interface BackupResultFile {
  fileName?: string;
  backupRemotePath?: string;
}

@Injectable()
export class SftpProcessingRetentionService {
  private readonly logger = new Logger(SftpProcessingRetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sftp: SftpConnectionService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 */10 * * * *')
  async prune() {
    if (this.running || this.config.get('SCHEDULED_JOBS_ENABLED', 'true') === 'false') return;
    this.running = true;
    const cutoff = new Date(Date.now() - RETENTION_MS);
    try {
      const executions = await this.prisma.fileIntegrationExecution.findMany({
        where: {
          rule: { kind: FileIntegrationKind.price_filter },
          finishedAt: { lt: cutoff },
          status: { notIn: ['pending', 'running'] },
        },
        include: { rule: { select: { sftpApplicationId: true } } },
        orderBy: { finishedAt: 'asc' }, take: MAX_EXECUTIONS_PER_PASS,
      });
      for (const execution of executions) {
        try {
          const result = execution.result as { files?: BackupResultFile[] } | null;
          const files = Array.isArray(result?.files) ? result.files : [];
          const backups = files.filter(file => file.backupRemotePath);
          if (backups.length > 0) {
            await this.sftp.withClient(execution.rule.sftpApplicationId, async (client, rootPath) => {
              const backupDirectory = posix.join(rootPath, '.tequila-backup', execution.id);
              for (const file of backups) {
                const source = this.sftp.safeRemotePath(rootPath, file.fileName || '');
                const expectedBackup = posix.join(backupDirectory, file.fileName || '');
                if (file.backupRemotePath !== expectedBackup) throw new Error('Backup path does not match this execution');
                if (await client.exists(source) !== '-') {
                  throw new Error(`Original file missing: ${file.fileName}; backup retained`);
                }
                const exists = await client.exists(expectedBackup);
                if (exists === '-') await client.delete(expectedBackup);
                else if (exists) throw new Error(`Unexpected backup type: ${file.fileName}`);
              }
              if (await client.exists(backupDirectory) === 'd') {
                const leftover = await client.list(backupDirectory);
                if (leftover.length > 0) throw new Error('Unrecognized files remain in backup directory');
                await client.rmdir(backupDirectory);
              }
            });
          }
          const artifactsRoot = resolve(process.cwd(), 'uploads', 'integrations');
          const artifactsPath = resolve(artifactsRoot, execution.id);
          if (!artifactsPath.startsWith(`${artifactsRoot}${sep}`)) throw new Error('Unsafe artifacts path');
          await rm(artifactsPath, { recursive: true, force: true });
          await this.prisma.fileIntegrationExecution.deleteMany({
            where: { id: execution.id, finishedAt: { lt: cutoff }, status: { notIn: ['pending', 'running'] } },
          });
        } catch (error) {
          this.logger.warn(`SFTP retention pending for ${execution.id}: ${String((error as Error)?.message || error).slice(0, 200)}`);
        }
      }
    } catch (error) {
      this.logger.error(`SFTP retention failed: ${String((error as Error)?.message || error).slice(0, 200)}`);
    } finally { this.running = false; }
  }
}
