import { Injectable } from '@nestjs/common';
import { FileIntegrationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { detectDelimiter, wildcardToRegExp } from './file-integration.util';
import { parsePromotionLines, promotionShopIdFromFileName } from './promotion-file.util';
import { SftpConnectionService } from './sftp-connection.service';
import { StorePromotionStorageService } from './store-promotion-storage.service';

interface RemoteCandidate {
  sftpApplicationId: string;
  sourceAccount: string;
  fileName: string;
  modifyTime: number;
  delimiter: string | null;
}

export interface TargetedPromotionRefreshResult {
  sftpApplicationId: string;
  sourceAccount: string;
  sourceFile: string;
  sourceModifiedAt: Date;
  accountsChecked: number;
  filesScanned: number;
  rowsStored: number;
  invalidRows: number;
}

@Injectable()
export class TargetedPromotionReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sftp: SftpConnectionService,
    private readonly storage: StorePromotionStorageService,
  ) {}

  async refreshSelectedStore(brandId: string, shopExternalId: string): Promise<TargetedPromotionRefreshResult> {
    const normalizedShopId = this.normalizeShopId(shopExternalId);
    if (!normalizedShopId) throw new Error('The selected store has no App Shop ID');

    const applications = await this.prisma.sftpApplication.findMany({
      where: { brandId, active: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        fileIntegrationRules: {
          where: { kind: FileIntegrationKind.complex_promotion_reader, deletedAt: null },
          select: { active: true, filePattern: true, delimiter: true, updatedAt: true },
          orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
          take: 1,
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
    });
    if (applications.length === 0) {
      throw new Error('The selected store brand has no active SFTP application linked');
    }

    const candidates: RemoteCandidate[] = [];
    const errors: string[] = [];
    let filesScanned = 0;
    for (const application of applications) {
      const rule = application.fileIntegrationRules[0];
      const matcher = wildcardToRegExp(rule?.filePattern || 'promocionesdidi_*.csv');
      try {
        await this.sftp.withClient(application.id, async (client, rootPath) => {
          const files = (await client.list(rootPath)).filter(file => file.type === '-' && matcher.test(file.name));
          filesScanned += files.length;
          const matching = files
            .filter(file => this.normalizeShopId(promotionShopIdFromFileName(file.name)) === normalizedShopId)
            .sort((left, right) => right.modifyTime - left.modifyTime || right.name.localeCompare(left.name));
          const latest = matching[0];
          if (latest) {
            candidates.push({
              sftpApplicationId: application.id,
              sourceAccount: application.name,
              fileName: latest.name,
              modifyTime: latest.modifyTime,
              delimiter: rule?.delimiter ?? null,
            });
          }
        });
      } catch (error) {
        errors.push(`${application.name}: ${this.safeError(error)}`);
      }
    }

    const selected = candidates.sort((left, right) =>
      right.modifyTime - left.modifyTime || right.fileName.localeCompare(left.fileName),
    )[0];
    if (!selected) {
      const detail = errors.length ? ` SFTP errors: ${errors.join(' | ')}` : '';
      throw new Error(
        `No promotion file was found in SFTP for selected App Shop ID ${shopExternalId}.${detail}`,
      );
    }

    const parsed = await this.sftp.withClient(selected.sftpApplicationId, async (client, rootPath) => {
      const remotePath = this.sftp.safeRemotePath(rootPath, selected.fileName);
      const value = await client.get(remotePath);
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/);
      const delimiter = detectDelimiter(lines[0] ?? '', selected.delimiter);
      return parsePromotionLines(lines, delimiter);
    });
    const selectedRows = parsed.rows.filter(
      row => this.normalizeShopId(row.shopExternalId) === normalizedShopId,
    );
    if (parsed.rows.length > 0 && selectedRows.length === 0) {
      throw new Error(
        `SFTP file ${selected.fileName} does not contain rows for selected App Shop ID ${shopExternalId}`,
      );
    }

    const sourceModifiedAt = new Date(selected.modifyTime);
    const rowsStored = await this.storage.replace(
      selected.sftpApplicationId,
      shopExternalId.trim(),
      selected.fileName,
      sourceModifiedAt,
      selectedRows,
    );
    return {
      sftpApplicationId: selected.sftpApplicationId,
      sourceAccount: selected.sourceAccount,
      sourceFile: selected.fileName,
      sourceModifiedAt,
      accountsChecked: applications.length,
      filesScanned,
      rowsStored,
      invalidRows: parsed.invalidRows,
    };
  }

  private normalizeShopId(value: string | null | undefined) {
    return value?.trim().toLocaleLowerCase('en-US') ?? '';
  }

  private safeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/password\s*[=:]\s*[^\s,;]+/gi, 'credential=<redacted>').slice(0, 500);
  }
}
