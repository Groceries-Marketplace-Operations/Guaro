import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertUpcActivityPriceRuleDto } from './dto/upsert-upc-activity-price-rule.dto';
import { nextOfferMenuRun } from './offer-menu-upload.util';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

@Injectable()
export class UpcActivityPriceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('upc-activity-price') private readonly queue: Queue,
  ) {}

  list() {
    return this.prisma.upcActivityPriceRule.findMany({
      where: { deletedAt: null },
      include: {
        application: { select: { id: true, appId: true, appName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        executions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async execution(id: string) {
    const execution = await this.prisma.upcActivityPriceExecution.findUnique({ where: { id } });
    if (!execution) throw new NotFoundException('UPC activity-price execution not found');
    return execution;
  }

  async create(dto: UpsertUpcActivityPriceRuleDto, accountId: string) {
    const data = await this.normalize(dto);
    const rule = await this.prisma.upcActivityPriceRule.create({
      data: { ...data, createdById: accountId, updatedById: accountId },
    });
    const execution = dto.runNow ? await this.run(rule.id, accountId) : null;
    return { rule, execution };
  }

  async update(id: string, dto: UpsertUpcActivityPriceRuleDto, accountId: string) {
    await this.findRule(id);
    await this.assertNotRunning(id);
    const data = await this.normalize(dto);
    return this.prisma.upcActivityPriceRule.update({
      where: { id },
      data: { ...data, updatedById: accountId },
    });
  }

  async remove(id: string) {
    await this.findRule(id);
    await this.assertNotRunning(id);
    return this.prisma.upcActivityPriceRule.update({
      where: { id },
      data: { active: false, nextRunAt: null, deletedAt: new Date() },
    });
  }

  async run(id: string, accountId?: string, trigger = 'manual') {
    const execution = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'upc-activity-price:' + id}))`;
      const rule = await tx.upcActivityPriceRule.findFirst({ where: { id, deletedAt: null } });
      if (!rule) throw new NotFoundException('UPC activity-price rule not found');
      this.assertLiveAllowed(rule.dryRun);
      const running = await tx.upcActivityPriceExecution.count({
        where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (running) throw new BadRequestException('This UPC activity-price rule is already running');
      return tx.upcActivityPriceExecution.create({
        data: {
          ruleId: id,
          trigger,
          dryRun: rule.dryRun,
          totalShops: rule.shopIds.length,
          createdById: accountId,
        },
      });
    });
    try {
      await this.queue.add('upc-activity-price-run', { executionId: execution.id }, {
        jobId: execution.id,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    } catch (error) {
      await this.prisma.upcActivityPriceExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', finishedAt: new Date(), errorMessage: 'Could not enqueue the execution' },
      });
      throw error;
    }
    return execution;
  }

  async stop(id: string) {
    await this.findRule(id);
    const result = await this.prisma.upcActivityPriceExecution.updateMany({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: new Date(),
        currentShopId: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This rule has no active execution');
    return { stopped: true };
  }

  private async normalize(dto: UpsertUpcActivityPriceRuleDto) {
    const application = await this.prisma.application.findFirst({
      where: { id: dto.applicationId, deletedAt: null },
      select: { id: true },
    });
    if (!application) throw new BadRequestException('Application not found');
    const timezone = dto.timezone?.trim() || 'America/Mexico_City';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException('Invalid IANA timezone');
    }
    const shopIds = [...new Set(dto.shopIds.map(value => value.trim()).filter(Boolean))];
    if (!shopIds.length) throw new BadRequestException('At least one Shop ID is required');
    const scheduleHours = [...new Set(dto.scheduleHours)].sort((a, b) => a - b);
    const dryRun = dto.dryRun ?? true;
    const active = dto.active ?? false;
    this.assertLiveAllowed(dryRun);
    return {
      name: dto.name.trim(),
      applicationId: dto.applicationId,
      shopIds,
      targetUpc: dto.targetUpc.trim(),
      active,
      dryRun,
      scheduleHours,
      timezone,
      storeConcurrency: dto.storeConcurrency ?? 2,
      nextRunAt: active ? nextOfferMenuRun(scheduleHours, timezone) : null,
    };
  }

  private assertLiveAllowed(dryRun: boolean) {
    const enabled = this.config.get('UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED', 'false').trim().toLowerCase() === 'true';
    if (!dryRun && !enabled) {
      throw new BadRequestException(
        'Live UPC activity-price writes are disabled on this server. Enable UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED only after reviewing a dry-run.',
      );
    }
  }

  private async assertNotRunning(ruleId: string) {
    const running = await this.prisma.upcActivityPriceExecution.count({
      where: { ruleId, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('Stop the active execution before changing this rule');
  }

  private async findRule(id: string) {
    const rule = await this.prisma.upcActivityPriceRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw new NotFoundException('UPC activity-price rule not found');
    return rule;
  }
}
