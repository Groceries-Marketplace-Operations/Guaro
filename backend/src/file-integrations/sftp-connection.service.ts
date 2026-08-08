import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import SftpClient = require('ssh2-sftp-client');
import { posix } from 'path';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SftpConnectionService {
  private readonly encryptionKey: string;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
  }

  async withClient<T>(applicationId: string, action: (client: SftpClient, rootPath: string) => Promise<T>): Promise<T> {
    return this.withClientPool(applicationId, 1, (clients, rootPath) => action(clients[0], rootPath));
  }

  async withClientPool<T>(
    applicationId: string,
    size: number,
    action: (clients: SftpClient[], rootPath: string) => Promise<T>,
  ): Promise<T> {
    const application = await this.prisma.sftpApplication.findFirst({
      where: { id: applicationId, active: true, deletedAt: null },
    });
    if (!application) throw new NotFoundException('Active SFTP application not found');
    const poolSize = Math.min(Math.max(Math.trunc(size), 1), 5);
    const clients = Array.from({ length: poolSize }, (_, index) => new SftpClient(`tequila-${application.id}-${index + 1}`));
    const password = decrypt(application.password, this.encryptionKey);
    try {
      await Promise.all(clients.map(client => client.connect({
        host: application.host,
        port: application.port,
        username: application.username,
        password,
        readyTimeout: 30_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        retries: 2,
        retry_minTimeout: 1500,
      })));
      return await action(clients, this.normalizeRoot(application.rootPath));
    } finally {
      await Promise.all(clients.map(client => client.end().catch(() => false)));
    }
  }

  safeRemotePath(rootPath: string, fileName: string) {
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
      throw new Error('Unsafe SFTP file name');
    }
    return posix.join(rootPath, fileName);
  }

  private normalizeRoot(value: string | null) {
    const normalized = posix.normalize(value?.trim() || '/upload');
    if (!normalized.startsWith('/')) throw new Error('SFTP root path must be absolute');
    return normalized;
  }
}
