import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { FileIntegrationKind, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { existsSync, readFileSync } from 'fs';
import { basename, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertFileIntegrationRuleDto } from './dto/upsert-file-integration-rule.dto';

const PROMOTION_SHOPS_PER_RUN_LIMIT = 20;

@Injectable()
export class FileIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('file-integrations') private readonly queue: Queue,
  ) {}

  async list(kind: FileIntegrationKind) {
    const rules = await this.prisma.fileIntegrationRule.findMany({
      where: { kind, deletedAt: null },
      include: {
        sftpApplication: { select: { id: true, name: true, host: true, port: true, rootPath: true, active: true } },
        executions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rules.map(rule => ({
      ...rule,
      maxFilesPerRun: rule.kind === FileIntegrationKind.complex_promotion_reader
        ? Math.min(rule.maxFilesPerRun, PROMOTION_SHOPS_PER_RUN_LIMIT)
        : rule.maxFilesPerRun,
      thresholdAmount: rule.thresholdAmount?.toString() ?? null,
      executions: rule.executions.map(execution => this.serializeExecution(execution)) }));
  }

  async create(dto: UpsertFileIntegrationRuleDto, createdById: string) {
    const data = await this.normalize(dto);
    return this.prisma.fileIntegrationRule.create({
      data: { ...data, createdById },
    });
  }

  async update(id: string, dto: UpsertFileIntegrationRuleDto) {
    await this.findRule(id);
    const data = await this.normalize(dto);
    return this.prisma.fileIntegrationRule.update({ where: { id }, data });
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
    const execution = await this.prisma.fileIntegrationExecution.create({
      data: { ruleId: id, trigger: 'manual', createdById },
    });
    await this.enqueue(execution.id, rule.name);
    return this.serializeExecution(execution);
  }

  async stop(id: string) {
    await this.findRule(id);
    const result = await this.prisma.fileIntegrationExecution.updateMany({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
      data: { cancelRequested: true },
    });
    if (!result.count) throw new BadRequestException('This rule has no active execution');
    return { stopped: true };
  }

  async executions(id: string, page = 1) {
    await this.findRule(id);
    const limit = 20;
    const [data, total] = await Promise.all([
      this.prisma.fileIntegrationExecution.findMany({
        where: { ruleId: id }, orderBy: { createdAt: 'desc' }, skip: (Math.max(page, 1) - 1) * limit, take: limit,
      }),
      this.prisma.fileIntegrationExecution.count({ where: { ruleId: id } }),
    ]);
    return { data: data.map(value => this.serializeExecution(value)), total, page: Math.max(page, 1), limit };
  }

  async download(executionId: string, fileName: string) {
    const execution = await this.prisma.fileIntegrationExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new NotFoundException('Execution not found');
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

  private async normalize(dto: UpsertFileIntegrationRuleDto): Promise<Prisma.FileIntegrationRuleUncheckedCreateInput> {
    const app = await this.prisma.sftpApplication.findFirst({
      where: { id: dto.sftpApplicationId, deletedAt: null }, select: { id: true },
    });
    if (!app) throw new BadRequestException('SFTP application not found');
    if (dto.kind === FileIntegrationKind.price_filter) {
      if (!dto.country || dto.thresholdAmount === undefined || dto.priceColumn === undefined) {
        throw new BadRequestException('Country, threshold amount and zero-based price column are required for price filters');
      }
      if (!dto.intervalMinutes) throw new BadRequestException('A recurrence interval is required for price filters');
    }
    const active = dto.active ?? false;
    return {
      name: dto.name.trim(), kind: dto.kind, country: dto.country ?? null,
      sftpApplicationId: dto.sftpApplicationId, active,
      intervalMinutes: dto.intervalMinutes ?? null,
      nextRunAt: active && dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60_000) : null,
      filePattern: dto.filePattern?.trim() || '*', sourceScope: dto.sourceScope?.trim() || 'all',
      thresholdAmount: dto.thresholdAmount === undefined ? null : new Prisma.Decimal(dto.thresholdAmount),
      delimiter: dto.delimiter?.trim() || null, priceColumn: dto.priceColumn ?? null,
      maxFilesPerRun: dto.kind === FileIntegrationKind.complex_promotion_reader
        ? Math.min(dto.maxFilesPerRun ?? PROMOTION_SHOPS_PER_RUN_LIMIT, PROMOTION_SHOPS_PER_RUN_LIMIT)
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
