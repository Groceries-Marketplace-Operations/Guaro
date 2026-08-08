import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertOfferMenuUploadRuleDto } from './dto/upsert-offer-menu-upload-rule.dto';
import { nextOfferMenuRun } from './offer-menu-upload.util';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

@Injectable()
export class OfferMenuUploadService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('offer-menu-upload') private readonly queue: Queue,
  ) {}

  async list() {
    const rules = await this.prisma.offerMenuUploadRule.findMany({
      where: { deletedAt: null },
      include: {
        sftpApplication: { select: { id: true, name: true, host: true, port: true, rootPath: true, active: true } },
        application: { select: { id: true, appId: true, appName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        executions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rules.map(rule => ({
      ...rule,
      lastSourceSize: rule.lastSourceSize?.toString() ?? null,
      executions: rule.executions.map(execution => ({ ...execution, sourceSize: execution.sourceSize?.toString() ?? null })),
    }));
  }

  async create(dto: UpsertOfferMenuUploadRuleDto, accountId: string) {
    const data = await this.normalize(dto);
    const rule = await this.prisma.offerMenuUploadRule.create({
      data: { ...data, createdById: accountId, updatedById: accountId },
    });
    const execution = dto.runNow ? await this.run(rule.id, accountId, 'manual', true) : null;
    return { rule, execution };
  }

  async update(id: string, dto: UpsertOfferMenuUploadRuleDto, accountId: string) {
    await this.assertIdle(id);
    const data = await this.normalize(dto);
    return this.prisma.offerMenuUploadRule.update({
      where: { id },
      data: { ...data, updatedById: accountId },
    });
  }

  async remove(id: string) {
    await this.assertIdle(id);
    return this.prisma.offerMenuUploadRule.update({
      where: { id },
      data: { active: false, nextRunAt: null, deletedAt: new Date() },
    });
  }

  async run(id: string, accountId?: string, trigger = 'manual', force = trigger === 'manual') {
    const rule = await this.findRule(id);
    const running = await this.prisma.offerMenuUploadExecution.count({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('This offer menu rule is already running');
    const execution = await this.prisma.offerMenuUploadExecution.create({
      data: { ruleId: id, trigger, force, createdById: accountId },
    });
    await this.queue.add('offer-menu-upload', { executionId: execution.id }, {
      jobId: execution.id,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return { ...execution, sourceSize: execution.sourceSize?.toString() ?? null, ruleName: rule.name };
  }

  async resumeExecution(executionId: string) {
    await this.queue.add('offer-menu-upload-resume', { executionId }, {
      jobId: `resume-${executionId}-${Date.now()}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  async stop(id: string) {
    await this.findRule(id);
    const result = await this.prisma.offerMenuUploadExecution.updateMany({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: new Date(),
        currentStoreId: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This rule has no active execution');
    return { stopped: true };
  }

  private async normalize(dto: UpsertOfferMenuUploadRuleDto) {
    const [sftpApplication, application] = await Promise.all([
      this.prisma.sftpApplication.findFirst({ where: { id: dto.sftpApplicationId, active: true, deletedAt: null }, select: { id: true } }),
      this.prisma.application.findFirst({ where: { id: dto.applicationId, deletedAt: null }, select: { id: true } }),
    ]);
    if (!sftpApplication) throw new BadRequestException('Active SFTP application not found');
    if (!application) throw new BadRequestException('DiDi application not found');
    const timezone = dto.timezone?.trim() || 'America/Mexico_City';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException('Invalid IANA timezone');
    }
    const scheduleHours = [...new Set(dto.scheduleHours)].sort((a, b) => a - b);
    const active = dto.active ?? false;
    return {
      name: dto.name.trim(),
      sftpApplicationId: dto.sftpApplicationId,
      applicationId: dto.applicationId,
      active,
      dryRun: dto.dryRun ?? true,
      scheduleHours,
      timezone,
      nextRunAt: active ? nextOfferMenuRun(scheduleHours, timezone) : null,
      filePattern: dto.filePattern?.trim() || 'offer*.csv',
      delimiter: dto.delimiter?.trim() || ';',
      categoryIdPrefix: dto.categoryIdPrefix?.trim() || 'category_0',
      categoryName: dto.categoryName?.trim() || 'Despensa',
      menuIdPrefix: dto.menuIdPrefix?.trim() || 'menu',
      menuNamePrefix: dto.menuNamePrefix?.trim() || 'Menu',
      mergePolicy: dto.mergePolicy ?? 1,
      storeConcurrency: dto.storeConcurrency ?? 2,
      maxItemsPerStore: dto.maxItemsPerStore ?? 30000,
      maxItemsPerCategory: dto.maxItemsPerCategory ?? 4999,
      activeStatus: dto.activeStatus ?? 1,
      includeTaxInfo: dto.includeTaxInfo ?? false,
      taxType: dto.taxType ?? 1,
      taxRate: dto.taxRate ?? 1600,
    };
  }

  private async assertIdle(id: string) {
    await this.findRule(id);
    const running = await this.prisma.offerMenuUploadExecution.count({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('Stop the active execution before changing this rule');
  }

  private async findRule(id: string) {
    const rule = await this.prisma.offerMenuUploadRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw new NotFoundException('Offer menu upload rule not found');
    return rule;
  }
}
