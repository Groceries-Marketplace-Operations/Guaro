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
    const application = await this.prisma.sftpApplication.findFirst({
      where: { id: applicationId, active: true, deletedAt: null },
    });
    if (!application) throw new NotFoundException('Active SFTP application not found');

    const client = new SftpClient(`tequila-${application.id}`);
    try {
      await client.connect({
        host: application.host,
        port: application.port,
        username: application.username,
        password: decrypt(application.password, this.encryptionKey),
        readyTimeout: 30_000,
        retries: 2,
        retry_minTimeout: 1500,
      });
      return await action(client, this.normalizeRoot(application.rootPath));
    } finally {
      await client.end().catch(() => false);
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
