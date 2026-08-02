import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAutoTurnOffPoolDto } from './dto/create-auto-turn-off-pool.dto';
import { UpdateAutoTurnOffPoolDto } from './dto/update-auto-turn-off-pool.dto';
import { CreateAutoTurnOffRuleDto } from './dto/create-auto-turn-off-rule.dto';
import { UpdateAutoTurnOffRuleDto } from './dto/update-auto-turn-off-rule.dto';

const RULE_INCLUDE = {
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  updatedBy: { select: { id: true, name: true, email: true } },
  executions: {
    select: {
      id: true,
      status: true,
      currentStep: true,
      progressCurrent: true,
      progressTotal: true,
      progressPercent: true,
      totalShops: true,
      shopsSucceeded: true,
      itemsTurnedOff: true,
      errorMessage: true,
      cancelledAt: true,
      startedAt: true,
      finishedAt: true,
    },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
};

const POOL_INCLUDE = {
  webhook: { select: { id: true, name: true } },
  rules: { include: RULE_INCLUDE, orderBy: { createdAt: 'asc' as const } },
};

@Injectable()
export class AutoTurnOffService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('auto-turn-off') private readonly coordinatorQueue: Queue,
    @InjectQueue('auto-turn-off-shop') private readonly shopQueue: Queue,
  ) {}

  listPools() {
    return this.prisma.autoTurnOffPool.findMany({
      include: POOL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findPool(id: string) {
    const pool = await this.prisma.autoTurnOffPool.findUnique({ where: { id }, include: POOL_INCLUDE });
    if (!pool) throw new NotFoundException('Auto turn off pool not found');
    return pool;
  }

  createPool(dto: CreateAutoTurnOffPoolDto) {
    const { webhookId, ...data } = dto;
    return this.prisma.autoTurnOffPool.create({
      data: {
        ...data,
        webhook: webhookId ? { connect: { id: webhookId } } : undefined,
      },
      include: POOL_INCLUDE,
    });
  }

  async updatePool(id: string, dto: UpdateAutoTurnOffPoolDto) {
    const current = await this.findPool(id);
    const { webhookId, ...data } = dto;
    const wasActivated = current.active === false && dto.active === true;

    return this.prisma.$transaction(async tx => {
      if (wasActivated) {
        const activeRules = await tx.autoTurnOffRule.findMany({
          where: { poolId: id, active: true },
          select: { id: true, startsAt: true, intervalMinutes: true },
        });
        await Promise.all(activeRules.map(rule => tx.autoTurnOffRule.update({
          where: { id: rule.id },
          data: { nextRunAt: this.nextOccurrence(rule.startsAt, rule.intervalMinutes) },
        })));
      }

      return tx.autoTurnOffPool.update({
        where: { id },
        data: {
          ...data,
          webhook: webhookId !== undefined
            ? (webhookId ? { connect: { id: webhookId } } : { disconnect: true })
            : undefined,
        },
        include: POOL_INCLUDE,
      });
    });
  }

  async removePool(id: string) {
    await this.findPool(id);
    return this.prisma.autoTurnOffPool.delete({ where: { id } });
  }

  async createRule(poolId: string, dto: CreateAutoTurnOffRuleDto, userId: string) {
    await this.findPool(poolId);
    const shopIds = this.normalizeShopIds(dto.shopIds);
    const upcs = this.normalizeUpcs(dto.upcs);
    await this.validateBrand(dto.brandId);
    this.validateEndpointLimits(dto.stockEndpoint, dto.intervalMinutes, upcs.length);
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    this.validateLifetime(startsAt, endsAt, dto.active ?? true);
    if (dto.active ?? true) await this.validateNoActiveShopConflicts(shopIds, dto.stockEndpoint);

    return this.prisma.autoTurnOffRule.create({
      data: {
        poolId,
        brandId: dto.brandId,
        name: dto.name.trim(),
        active: dto.active ?? true,
        intervalMinutes: dto.intervalMinutes,
        upcs,
        shopIds,
        resolvedShopIds: {},
        stockEndpoint: dto.stockEndpoint,
        startsAt,
        endsAt,
        nextRunAt: this.nextOccurrence(startsAt, dto.intervalMinutes),
        createdById: userId,
        updatedById: userId,
      },
      include: RULE_INCLUDE,
    });
  }

  async findRule(id: string) {
    const rule = await this.prisma.autoTurnOffRule.findUnique({ where: { id }, include: RULE_INCLUDE });
    if (!rule) throw new NotFoundException('Auto turn off rule not found');
    return rule;
  }

  async updateRule(id: string, dto: UpdateAutoTurnOffRuleDto, userId: string) {
    const current = await this.findRule(id);
    const brandId = dto.brandId ?? current.brandId;
    const shopIds = dto.shopIds ? this.normalizeShopIds(dto.shopIds) : current.shopIds;
    const upcs = dto.upcs ? this.normalizeUpcs(dto.upcs) : current.upcs;
    const stockEndpoint = dto.stockEndpoint ?? current.stockEndpoint;
    const intervalMinutes = dto.intervalMinutes ?? current.intervalMinutes;
    await this.validateBrand(brandId);
    this.validateEndpointLimits(stockEndpoint, intervalMinutes, upcs.length);
    if (dto.active ?? current.active) await this.validateNoActiveShopConflicts(shopIds, stockEndpoint, id);

    const intervalChanged = dto.intervalMinutes !== undefined && dto.intervalMinutes !== current.intervalMinutes;
    const startChanged = dto.startsAt !== undefined
      && new Date(dto.startsAt).getTime() !== current.startsAt.getTime();
    const wasActivated = current.active === false && dto.active === true;
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : current.startsAt;
    const endsAt = dto.endsAt === undefined
      ? current.endsAt
      : (dto.endsAt ? new Date(dto.endsAt) : null);
    this.validateLifetime(startsAt, endsAt, dto.active ?? current.active);

    return this.prisma.autoTurnOffRule.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        brandId: dto.brandId,
        upcs,
        shopIds,
        resolvedShopIds: dto.shopIds !== undefined || dto.brandId !== undefined ? {} : undefined,
        stockEndpoint: dto.stockEndpoint,
        startsAt: dto.startsAt ? startsAt : undefined,
        endsAt: dto.endsAt === undefined ? undefined : endsAt,
        intervalMinutes: dto.intervalMinutes,
        active: dto.active,
        updatedById: userId,
        nextRunAt: intervalChanged || startChanged || wasActivated
          ? this.nextOccurrence(startsAt, intervalMinutes)
          : undefined,
      },
      include: RULE_INCLUDE,
    });
  }

  async removeRule(id: string) {
    await this.findRule(id);
    return this.prisma.autoTurnOffRule.delete({ where: { id } });
  }

  async runRuleNow(id: string) {
    const rule = await this.findRule(id);
    const now = new Date();
    if (rule.startsAt > now) throw new BadRequestException('This rule has not reached its start date yet');
    if (rule.endsAt && rule.endsAt <= now) {
      if (rule.active) await this.prisma.autoTurnOffRule.update({ where: { id }, data: { active: false } });
      throw new BadRequestException('This rule has already reached its automatic end date');
    }
    await this.validateNoActiveShopConflicts(rule.shopIds, rule.stockEndpoint, id);
    const activeExecution = await this.prisma.autoTurnOffExecution.findFirst({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (activeExecution) throw new BadRequestException('This rule already has an execution pending or running');
    if (rule.stockEndpoint === 'setStock'
      && rule.lastRunAt
      && Date.now() - rule.lastRunAt.getTime() < 10 * 60_000) {
      throw new BadRequestException('This rule is inside the 10-minute Stock API cooldown');
    }
    return this.enqueueExecution(rule.poolId, rule.id, 'manual');
  }

  async stopRule(id: string, userId: string) {
    const [rule, user] = await Promise.all([
      this.findRule(id),
      this.prisma.account.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    ]);
    const executions = await this.prisma.autoTurnOffExecution.findMany({
      where: { ruleId: id, status: { in: ['pending', 'running'] } },
      select: { id: true, shops: { select: { id: true } } },
    });
    const stoppedBy = user?.name || user?.email || userId;
    const message = `Stopped by ${stoppedBy}`;
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.autoTurnOffRule.update({
        where: { id: rule.id },
        data: { active: false, updatedById: userId },
      }),
      this.prisma.autoTurnOffExecution.updateMany({
        where: { id: { in: executions.map(execution => execution.id) }, status: { in: ['pending', 'running'] } },
        data: {
          status: 'cancelled',
          currentStep: 'cancelled',
          errorMessage: message,
          cancelledById: userId,
          cancelledAt: now,
          finishedAt: now,
        },
      }),
      this.prisma.autoTurnOffShopExecution.updateMany({
        where: {
          executionId: { in: executions.map(execution => execution.id) },
          status: { in: ['pending', 'running'] },
        },
        data: { status: 'cancelled', currentStep: 'cancelled', finishedAt: now },
      }),
    ]);

    await Promise.allSettled([
      ...executions.map(execution => this.removeWaitingJob(this.coordinatorQueue, execution.id)),
      ...executions.flatMap(execution => execution.shops.map(shop => this.removeWaitingJob(this.shopQueue, shop.id))),
    ]);

    return {
      ruleId: id,
      stoppedExecutions: executions.length,
      status: executions.length > 0 ? 'cancelled' : 'inactive',
      message: executions.length > 0
        ? 'Cancellation requested. Active workers will stop before their next external API step.'
        : 'Rule deactivated; there was no running execution.',
    };
  }

  async enqueueExecution(poolId: string, ruleId: string, trigger: 'manual' | 'scheduled') {
    const execution = await this.prisma.autoTurnOffExecution.create({
      data: {
        poolId,
        ruleId,
        trigger,
        status: 'pending',
        currentStep: 'queued',
        progressCurrent: 0,
        progressTotal: 1,
        progressPercent: 0,
      },
    });
    try {
      // DiDi only accepts one Stock API request per store every 10 minutes.
      // Disable BullMQ's global quick retries to avoid violating that limit.
      await this.coordinatorQueue.add('turn-off-items', { executionId: execution.id }, { jobId: execution.id, attempts: 1 });
      return execution;
    } catch (error) {
      await this.prisma.autoTurnOffExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          currentStep: 'failed',
          progressPercent: 100,
          errorMessage: (error as Error).message,
          finishedAt: new Date(),
          logs: { error: (error as Error).message },
        },
      });
      throw error;
    }
  }

  async listExecutions(poolId: string, page = 1, limit = 20) {
    await this.findPool(poolId);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const where = { poolId };
    const [data, total] = await Promise.all([
      this.prisma.autoTurnOffExecution.findMany({
        where,
        include: { rule: { select: { id: true, name: true, brand: { select: { brandName: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.autoTurnOffExecution.count({ where }),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  async listExecutionShops(executionId: string, page = 1, limit = 50, status?: string) {
    const execution = await this.prisma.autoTurnOffExecution.findUnique({
      where: { id: executionId },
      select: { id: true, rule: { select: { upcs: true } } },
    });
    if (!execution) throw new NotFoundException('Auto turn off execution not found');

    const allowedStatuses: string[] = Object.values(AutoOpenStatus);
    if (status && !allowedStatuses.includes(status)) {
      throw new BadRequestException(`Invalid shop execution status: ${status}`);
    }

    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);
    const where: Prisma.AutoTurnOffShopExecutionWhereInput = {
      executionId,
      ...(status ? { status: status as AutoOpenStatus } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.autoTurnOffShopExecution.findMany({
        where,
        select: {
          id: true,
          shopId: true,
          appShopId: true,
          status: true,
          currentStep: true,
          itemsSucceeded: true,
          itemsFailed: true,
          result: true,
          startedAt: true,
          finishedAt: true,
        },
        orderBy: { createdAt: 'asc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.autoTurnOffShopExecution.count({ where }),
    ]);
    return { data, total, page: safePage, limit: safeLimit, requestedUpcs: execution.rule.upcs };
  }

  private nextOccurrence(startsAt: Date, intervalMinutes: number, after = new Date()) {
    if (startsAt.getTime() >= after.getTime()) return startsAt;
    const intervalMs = intervalMinutes * 60_000;
    const elapsed = after.getTime() - startsAt.getTime();
    return new Date(startsAt.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
  }

  private unique(values: string[]) {
    return [...new Set(values)];
  }

  private normalizeUpcs(upcs: string[]) {
    const normalized = this.unique(upcs.map(upc => upc.trim()).filter(Boolean));
    if (normalized.length === 0) throw new BadRequestException('At least one valid UPC is required');
    if (normalized.some(upc => upc.length > 120)) throw new BadRequestException('UPC values cannot exceed 120 characters');
    return normalized;
  }

  private normalizeShopIds(shopIds: string[]) {
    const normalized = this.unique(shopIds.map(shopId => shopId.trim()).filter(Boolean));
    if (normalized.length === 0) throw new BadRequestException('At least one shop_id is required');
    const invalid = normalized.filter(shopId => !/^57\d{17}$/.test(shopId));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid DiDi shop_id: ${invalid.slice(0, 5).join(', ')}. Expected 19 digits starting with 57`,
      );
    }
    return normalized;
  }

  private validateEndpointLimits(stockEndpoint: string, intervalMinutes: number, upcCount: number) {
    if (stockEndpoint === 'setStock' && intervalMinutes < 10) {
      throw new BadRequestException('setStock requires an interval of at least 10 minutes per shop');
    }
    if (stockEndpoint === 'setstockSync' && upcCount > 2000) {
      throw new BadRequestException('setstockSync accepts a maximum of 2000 UPCs per rule');
    }
  }

  private validateLifetime(startsAt: Date, endsAt: Date | null, active: boolean) {
    if (endsAt && endsAt <= startsAt) {
      throw new BadRequestException('Automatic end date must be later than the start date');
    }
    if (active && endsAt && endsAt <= new Date()) {
      throw new BadRequestException('An active rule cannot have an automatic end date in the past');
    }
  }

  private async removeWaitingJob(queue: Queue, jobId: string) {
    const job = await queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'].includes(state)) {
      await job.remove();
    }
  }

  private async validateBrand(brandId: string) {
    const brand = await this.prisma.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { id: true } });
    if (!brand) throw new BadRequestException('Brand not found');
  }

  private async validateNoActiveShopConflicts(
    shopIds: string[],
    stockEndpoint: string,
    excludeRuleId?: string,
  ) {
    if (stockEndpoint !== 'setStock') return;
    const activeRules = await this.prisma.autoTurnOffRule.findMany({
      where: {
        active: true,
        stockEndpoint: 'setStock',
        ...(excludeRuleId ? { id: { not: excludeRuleId } } : {}),
      },
      select: { name: true, shopIds: true },
    });
    const targetIds = new Set(shopIds);
    const conflict = activeRules
      .map(rule => ({ rule, shopId: rule.shopIds.find(shopId => targetIds.has(shopId)) }))
      .find(item => item.shopId);
    if (conflict) {
      throw new BadRequestException(
        `Shop ${conflict.shopId} is already targeted by active setStock rule "${conflict.rule.name}". `
        + 'Combine the UPCs or use different stores to respect the DiDi 10-minute Stock API limit.',
      );
    }
  }
}
