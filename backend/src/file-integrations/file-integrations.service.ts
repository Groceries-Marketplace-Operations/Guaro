import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Country, FileIntegrationKind, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { existsSync, readFileSync } from 'fs';
import { basename, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAILY_STATUS_ACTIVATION_TIME,
  DAILY_STATUS_ACTIVATION_TIMEZONE,
  nextDailyFileIntegrationRun,
} from './daily-status-activation.util';
import { UpsertFileIntegrationRuleDto } from './dto/upsert-file-integration-rule.dto';
import { normalizeUpc, parseSftpFilterMode, priceFilterTimeZone, SFTP_FILTER_MAX_CODES } from './file-integration.util';

const PROMOTION_SHOPS_PER_RUN_LIMIT = 20;

@Injectable()
export class FileIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('file-integrations') private readonly queue: Queue,
  ) {}

  async list(kind: FileIntegrationKind) {
    const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rules = await this.prisma.fileIntegrationRule.findMany({
      where: { kind, deletedAt: null },
      include: {
        sftpApplication: { select: { id: true, name: true, host: true, port: true, rootPath: true, active: true } },
        executions: {
          where: kind === FileIntegrationKind.price_filter
            ? { OR: [{ finishedAt: { gte: recentCutoff } }, { status: { in: ['pending', 'running'] } }] }
            : undefined,
          orderBy: { createdAt: 'desc' }, take: 5,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const stateCounts = rules.length > 0 ? await this.prisma.fileIntegrationFileState.groupBy({
      by: ['ruleId', 'status'],
      where: { ruleId: { in: rules.map(rule => rule.id) } },
      _count: { _all: true },
    }) : [];
    return rules.map(rule => ({
      ...rule,
      maxFilesPerRun: rule.kind === FileIntegrationKind.complex_promotion_reader
        ? Math.min(rule.maxFilesPerRun, PROMOTION_SHOPS_PER_RUN_LIMIT)
        : rule.maxFilesPerRun,
      thresholdAmount: rule.thresholdAmount?.toString() ?? null,
      fileState: stateCounts.filter(value => value.ruleId === rule.id).reduce((summary, value) => ({
        ...summary,
        total: summary.total + value._count._all,
        [value.status]: value._count._all,
      }), { total: 0, pending: 0, running: 0, done: 0, failed: 0 }),
      executions: rule.executions.map(execution => this.serializeExecution(execution)) }));
  }

  async create(dto: UpsertFileIntegrationRuleDto, createdById: string) {
    const data = await this.normalize(dto);
    if (data.kind === FileIntegrationKind.price_filter) {
      const existing = await this.prisma.fileIntegrationRule.findFirst({
        where: {
          kind: FileIntegrationKind.price_filter,
          deletedAt: null,
          sftpApplicationId: data.sftpApplicationId,
          filePattern: data.filePattern,
          sourceScope: data.sourceScope,
        },
        select: { id: true, name: true },
      });
      if (existing) {
        throw new BadRequestException(`An SFTP processing rule already covers these files (${existing.name}). Edit the existing rule instead`);
      }
    }
    return this.prisma.fileIntegrationRule.create({
      data: { ...data, createdById },
    });
  }

  async update(id: string, dto: UpsertFileIntegrationRuleDto) {
    const current = await this.findRule(id);
    if (current.kind === FileIntegrationKind.price_filter || dto.kind === FileIntegrationKind.price_filter) {
      const activeExecution = await this.prisma.fileIntegrationExecution.count({
        where: { ruleId: id, status: { in: ['pending', 'running'] } },
      });
      if (activeExecution) {
        throw new BadRequestException('Stop the active SFTP processing execution before editing this rule');
      }
    }
    const data = await this.normalize(dto, current.filterMode);
    const fileSelectionChanged = current.sftpApplicationId !== data.sftpApplicationId
      || current.country !== data.country
      || current.filePattern !== data.filePattern
      || current.sourceScope !== data.sourceScope
      || current.filterMode !== data.filterMode
      || current.delimiter !== data.delimiter
      || current.priceColumn !== data.priceColumn
      || current.upcColumn !== data.upcColumn
      || current.excludedUpcs.join('\n') !== (data.excludedUpcs as string[]).join('\n')
      || current.thresholdAmount?.toString() !== data.thresholdAmount?.toString();
    return this.prisma.$transaction(async tx => {
      if (fileSelectionChanged) {
        await tx.fileIntegrationFileState.deleteMany({ where: { ruleId: id } });
      }
      return tx.fileIntegrationRule.update({
        where: { id },
        data: {
          ...data,
          // Code-list edits must revisit files already seen by this rule.
          // Amount-only rules retain their prior history semantics.
          fileStateInitializedAt: fileSelectionChanged
            ? data.filterMode === 'code' || data.filterMode === 'amount_and_code'
              ? new Date()
              : null
            : undefined,
        },
      });
    });
  }

  async remove(id: string) {
    await this.findRule(id);
    const running = await this.prisma.fileIntegrationExecution.count({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
    });
    if (running) throw new BadRequestException('Stop the running execution before deleting this rule');
    return this.prisma.fileIntegrationRule.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, nextRunAt: null },
    });
  }

  async run(id: string, createdById: string) {
    const rule = await this.findRule(id);
    const active = await this.prisma.fileIntegrationExecution.findFirst({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
    });
    if (active) throw new BadRequestException('This rule already has a pending or running execution');
    if (rule.kind === FileIntegrationKind.price_filter) {
      await this.prisma.fileIntegrationFileState.updateMany({
        where: { ruleId: id, status: 'failed' },
        data: { status: 'pending', attempts: 0, lastError: null, processingAt: null },
      });
    }
    const execution = await this.prisma.fileIntegrationExecution.create({
      data: { ruleId: id, trigger: 'manual', createdById },
    });
    await this.enqueue(execution.id, rule.name);
    return this.serializeExecution(execution);
  }

  async stop(id: string) {
    await this.findRule(id);
    const now = new Date();
    const result = await this.prisma.fileIntegrationExecution.updateMany({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
      data: {
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: now,
        currentFile: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This rule has no active execution');
    return { stopped: true };
  }

  async executions(id: string, page = 1) {
    const rule = await this.findRule(id);
    const where: Prisma.FileIntegrationExecutionWhereInput = rule.kind === FileIntegrationKind.price_filter
      ? { ruleId: id, OR: [
        { finishedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        { status: { in: ['pending', 'running'] } },
      ] }
      : { ruleId: id };
    const limit = 20;
    const [data, total] = await Promise.all([
      this.prisma.fileIntegrationExecution.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (Math.max(page, 1) - 1) * limit, take: limit,
      }),
      this.prisma.fileIntegrationExecution.count({ where }),
    ]);
    return { data: data.map(value => this.serializeExecution(value)), total, page: Math.max(page, 1), limit };
  }

  async download(executionId: string, fileName: string) {
    const execution = await this.prisma.fileIntegrationExecution.findUnique({ where: { id: executionId }, include: { rule: { select: { kind: true } } } });
    if (!execution) throw new NotFoundException('Execution not found');
    if (execution.rule.kind === FileIntegrationKind.price_filter && execution.finishedAt
      && execution.finishedAt.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      throw new NotFoundException('Execution report expired after 24 hours');
    }
    const safeName = basename(fileName);
    if (safeName !== fileName) throw new BadRequestException('Invalid file name');
    const base = resolve(process.cwd(), 'uploads', 'integrations', executionId);
    const path = resolve(base, safeName);
    if (!path.startsWith(`${base}${sep}`) || !existsSync(path)) throw new NotFoundException('Processed file not found');
    return { fileName: safeName, contentBase64: readFileSync(path).toString('base64'), mimeType: 'text/csv' };
  }

  async enqueue(executionId: string, name: string) {
    await this.queue.add('process-file-integration', { executionId }, {
      jobId: executionId, attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 100,
    });
    return { executionId, name };
  }

  private async normalize(
    dto: UpsertFileIntegrationRuleDto,
    currentFilterMode?: string,
  ): Promise<Prisma.FileIntegrationRuleUncheckedCreateInput> {
    const app = await this.prisma.sftpApplication.findFirst({
      where: { id: dto.sftpApplicationId, deletedAt: null }, select: { id: true, name: true, active: true },
    });
    if (!app) throw new BadRequestException('SFTP application not found');
    if (dto.kind === FileIntegrationKind.price_filter && dto.active === true && !app.active) {
      throw new BadRequestException('Activate the SFTP application before enabling this processing rule');
    }
    const requestedCodes = (dto.excludedUpcs ?? []).map(normalizeUpc);
    if (requestedCodes.some(code => !code || code.length > 64 || /[\r\n\0]/.test(code))) {
      throw new BadRequestException('Every code must be a non-empty value of at most 64 characters');
    }
    const excludedUpcs = [...new Set(requestedCodes)];
    if (excludedUpcs.length > SFTP_FILTER_MAX_CODES) {
      throw new BadRequestException(`A code filter supports at most ${SFTP_FILTER_MAX_CODES.toLocaleString('en-US')} unique codes`);
    }
    const filterMode = dto.kind === FileIntegrationKind.price_filter
      ? parseSftpFilterMode(dto.filterMode
        ?? currentFilterMode
        ?? (excludedUpcs.length > 0 ? 'amount_and_code' : 'amount'))
      : 'amount';
    const byAmount = filterMode === 'amount' || filterMode === 'amount_and_code';
    const byCode = filterMode === 'code' || filterMode === 'amount_and_code';
    if (dto.kind === FileIntegrationKind.price_filter) {
      if (!dto.country) {
        throw new BadRequestException('Country is required for SFTP processing rules');
      }
      const scope = dto.sourceScope?.trim() || 'all';
      if (!['all', 'city_club'].includes(scope) || (scope === 'city_club' && dto.country !== Country.MX)) {
        throw new BadRequestException('City Club scope is available only for Mexico; use all for other countries');
      }
      if (scope === 'city_club' && !/soriana|city\s*club/i.test(app.name)) {
        throw new BadRequestException('City Club scope requires the Soriana SFTP account');
      }
      if (!dto.intervalMinutes) throw new BadRequestException('A recurrence interval is required for price filters');
      if (byAmount && (dto.thresholdAmount === undefined || dto.priceColumn === undefined)) {
        throw new BadRequestException('Amount filters require a threshold and zero-based amount column');
      }
      if (byCode && (excludedUpcs.length === 0 || dto.upcColumn === undefined)) {
        throw new BadRequestException('Code filters require codes and a zero-based code column');
      }
    }
    if (dto.kind === FileIntegrationKind.store_file_splitter) {
      if (!dto.dailyTime && !dto.intervalMinutes) {
        throw new BadRequestException('A daily time or recurrence interval is required for store file splitters');
      }
      if (!['mtime', 'nameDate'].includes(dto.sourceScope ?? 'mtime')) {
        throw new BadRequestException('Store file selection must use mtime or nameDate');
      }
    }
    const dailyTime = dto.kind === FileIntegrationKind.daily_status_activation
      ? dto.dailyTime?.trim() || DAILY_STATUS_ACTIVATION_TIME
      : dto.kind === FileIntegrationKind.store_file_splitter
        ? dto.dailyTime?.trim() || null
        : null;
    const timezone = dto.kind === FileIntegrationKind.price_filter
      ? priceFilterTimeZone(dto.country)
      : dto.timezone?.trim() || (dto.kind === FileIntegrationKind.store_file_splitter
        ? 'Etc/GMT+6'
        : DAILY_STATUS_ACTIVATION_TIMEZONE);
    if (dailyTime) {
      try {
        nextDailyFileIntegrationRun(dailyTime, timezone);
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'Invalid daily schedule');
      }
    }
    if (dto.kind === FileIntegrationKind.price_filter && (dto.maxFilesPerRun ?? 250) > 1000) {
      throw new BadRequestException('Price filters support at most 1000 files per execution');
    }
    const active = dto.active ?? false;
    const nextRunAt = !active
      ? null
      : dailyTime
        ? nextDailyFileIntegrationRun(dailyTime, timezone)
        : dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60_000) : null;
    return {
      name: dto.name.trim(), kind: dto.kind, country: dto.country ?? null,
      sftpApplicationId: dto.sftpApplicationId, active,
      intervalMinutes: dailyTime ? null : dto.intervalMinutes ?? null,
      dailyTime,
      timezone,
      parallelism: dto.kind === FileIntegrationKind.daily_status_activation ? dto.parallelism ?? 3 : 1,
      nextRunAt,
      filePattern: dto.filePattern?.trim() || (dto.kind === FileIntegrationKind.daily_status_activation ? '*.csv' : '*'),
      sourceScope: dto.kind === FileIntegrationKind.store_file_splitter
        ? dto.sourceScope?.trim() || 'mtime'
        : dto.kind === FileIntegrationKind.daily_status_activation
          ? 'filename_date_today'
          : dto.sourceScope?.trim() || 'all',
      filterMode,
      thresholdAmount: dto.kind === FileIntegrationKind.price_filter && !byAmount
        ? null
        : dto.thresholdAmount === undefined ? null : new Prisma.Decimal(dto.thresholdAmount),
      delimiter: dto.kind === FileIntegrationKind.store_file_splitter
        || dto.kind === FileIntegrationKind.daily_status_activation
        ? '|'
        : dto.delimiter?.trim() || null,
      priceColumn: dto.kind === FileIntegrationKind.price_filter && !byAmount ? null : dto.priceColumn ?? null,
      upcColumn: dto.kind === FileIntegrationKind.price_filter && byCode ? dto.upcColumn ?? null : null,
      excludedUpcs: dto.kind === FileIntegrationKind.price_filter && byCode ? excludedUpcs : [],
      maxFilesPerRun: dto.kind === FileIntegrationKind.complex_promotion_reader
        ? Math.min(dto.maxFilesPerRun ?? PROMOTION_SHOPS_PER_RUN_LIMIT, PROMOTION_SHOPS_PER_RUN_LIMIT)
        : dto.kind === FileIntegrationKind.store_file_splitter ? 1
          : dto.kind === FileIntegrationKind.daily_status_activation ? dto.maxFilesPerRun ?? 1000
            : dto.maxFilesPerRun ?? 250,
    };
  }

  private async findRule(id: string) {
    const rule = await this.prisma.fileIntegrationRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw new NotFoundException('File integration rule not found');
    return rule;
  }

  private serializeExecution<T extends { bytesRead: bigint }>(execution: T) {
    return { ...execution, bytesRead: execution.bytesRead.toString() };
  }
}
