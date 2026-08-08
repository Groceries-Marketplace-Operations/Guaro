import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertTargetedMenuRuleDto } from './dto/upsert-targeted-menu-rule.dto';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

@Injectable()
export class TargetedMenuService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('targeted-menu') private readonly queue: Queue,
  ) {}

  async list() {
    return this.prisma.targetedMenuRule.findMany({
      where: { deletedAt: null },
      include: {
        brand: { select: { id: true, brandId: true, brandName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        executions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: UpsertTargetedMenuRuleDto, accountId: string) {
    const data = await this.normalize(dto);
    const rule = await this.prisma.targetedMenuRule.create({
      data: { ...data, createdById: accountId, updatedById: accountId },
    });
    const execution = dto.runNow ? await this.run(rule.id, accountId) : null;
    return { rule, execution };
  }

  async update(id: string, dto: UpsertTargetedMenuRuleDto, accountId: string) {
    await this.findRule(id);
    const running = await this.prisma.targetedMenuExecution.count({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('Stop the active execution before editing this rule');
    const data = await this.normalize(dto);
    return this.prisma.targetedMenuRule.update({
      where: { id }, data: { ...data, updatedById: accountId },
    });
  }

  async remove(id: string) {
    await this.findRule(id);
    const running = await this.prisma.targetedMenuExecution.count({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('Stop the active execution before deleting this rule');
    return this.prisma.targetedMenuRule.update({
      where: { id }, data: { active: false, nextRunAt: null, deletedAt: new Date() },
    });
  }

  async run(id: string, accountId?: string, trigger = 'manual') {
    const rule = await this.findRule(id);
    const running = await this.prisma.targetedMenuExecution.findFirst({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('This targeted menu rule is already running');
    const execution = await this.prisma.targetedMenuExecution.create({
      data: { ruleId: id, trigger, createdById: accountId, totalShops: rule.shopIds.length },
    });
    await this.enqueue(execution.id, rule.name);
    return execution;
  }

  async stop(id: string) {
    await this.findRule(id);
    const now = new Date();
    const result = await this.prisma.targetedMenuExecution.updateMany({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: now,
        currentShopId: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This rule has no active execution');
    return { stopped: true };
  }

  async enqueue(executionId: string, name: string) {
    await this.queue.add('targeted-menu-upload', { executionId }, {
      jobId: executionId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return { executionId, name };
  }

  async resume(executionId: string, name: string) {
    // Use a distinct BullMQ id because the pre-restart active job can remain
    // locked in Redis until the stalled-job check runs. The DB claim ensures
    // that only one of the old/new jobs can continue the execution.
    await this.queue.add('targeted-menu-upload', { executionId }, {
      jobId: `${executionId}-resume-${Date.now()}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return { executionId, name };
  }

  private async normalize(dto: UpsertTargetedMenuRuleDto) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: dto.brandId, deletedAt: null },
      select: { id: true, applicationId: true },
    });
    if (!brand) throw new BadRequestException('Brand not found');
    if (!brand.applicationId) throw new BadRequestException('The brand has no DiDi application linked');
    const startsAt = new Date(dto.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException('Invalid start date');
    const active = dto.active ?? true;
    const nextRunAt = active
      ? dto.runNow
        ? new Date(startsAt.getTime() + 24 * 60 * 60_000)
        : startsAt
      : null;
    return {
      name: dto.name.trim(),
      brandId: dto.brandId,
      shopIds: dto.shopIds,
      upcs: dto.upcs,
      mergePolicy: dto.mergePolicy ?? 1,
      uploadEndpoint: dto.uploadEndpoint ?? 'uploadGrocery',
      active,
      startsAt,
      nextRunAt,
    };
  }

  private async findRule(id: string) {
    const rule = await this.prisma.targetedMenuRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw new NotFoundException('Targeted menu rule not found');
    return rule;
  }
}
