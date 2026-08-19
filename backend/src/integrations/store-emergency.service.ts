import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreEmergencyDto } from './dto/create-store-emergency.dto';
import { UpdateStoreEmergencyReopeningDto } from './dto/update-store-emergency-reopening.dto';
import {
  emergencyEventData,
  sanitizeEmergencyMessage,
  STORE_EMERGENCY_EVENT_OUTCOMES,
  STORE_EMERGENCY_EVENT_PHASES,
  STORE_EMERGENCY_EVENT_SOURCES,
  StoreEmergencyEventOutcome,
  StoreEmergencyEventPhase,
  StoreEmergencyEventSource,
  StoreEmergencyJobData,
} from './store-emergency-events';

const ACTIVE_STATUSES = ['pending', 'running', 'offline', 'partial_success', 'restoring', 'partial_restored', 'restore_failed'];
const LIVE_STATUSES = ['pending', 'running', 'offline', 'partial_success', 'restoring'];
const REOPENING_EDITABLE_STATUSES = ['pending', 'running', 'offline', 'partial_success'];
const TARGET_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
const TARGET_PHASES = ['shutdown', 'restore'] as const;

interface TargetCountRow {
  emergencyId: string;
  offlineStatus: string;
  restoreStatus: string;
  _count: { _all: number };
}

export interface StoreEmergencyTargetCounts {
  total: number;
  shutdownSucceeded: number;
  shutdownFailed: number;
  shutdownPending: number;
  restoreSucceeded: number;
  restoreFailed: number;
  restorePending: number;
}

@Injectable()
export class StoreEmergencyService {
  private readonly logger = new Logger(StoreEmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('store-emergency') private readonly queue: Queue,
  ) {}

  async create(dto: CreateStoreEmergencyDto, createdById: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: dto.brandId },
      select: { id: true, brandName: true, deletedAt: true, applicationId: true },
    });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    if (!brand.applicationId) throw new BadRequestException('The brand has no linked application credentials');
    if (dto.endsAt.getTime() <= Date.now()) throw new BadRequestException('Emergency end date must be in the future');

    const requestedIds = dto.mode === 'shop_list'
      ? [...new Set((dto.shopIds ?? []).map(value => value.trim()).filter(Boolean))]
      : [];
    if (dto.mode === 'shop_list' && requestedIds.length === 0) {
      throw new BadRequestException('At least one shop_id is required');
    }

    const shops = await this.prisma.shop.findMany({
      where: {
        brandId: brand.id,
        deletedAt: null,
        ...(dto.mode === 'shop_list' ? { shopId: { in: requestedIds } } : {}),
      },
      select: { id: true, shopId: true },
      orderBy: { shopId: 'asc' },
    });
    if (shops.length === 0) throw new BadRequestException('No local stores matched this emergency');
    if (dto.mode === 'shop_list') {
      const found = new Set(shops.map(shop => shop.shopId));
      const missing = requestedIds.filter(shopId => !found.has(shopId));
      if (missing.length > 0) {
        throw new BadRequestException(
          `${missing.length} shop_id value(s) are not stored locally for this brand: ${missing.slice(0, 10).join(', ')}`,
        );
      }
    }

    const conflict = await this.prisma.storeEmergencyTarget.findFirst({
      where: {
        shopId: { in: shops.map(shop => shop.id) },
        emergency: { status: { in: ACTIVE_STATUSES } },
      },
      select: { shop: { select: { shopId: true } }, emergencyId: true },
    });
    if (conflict) {
      throw new BadRequestException(
        `Store ${conflict.shop.shopId} already belongs to active emergency ${conflict.emergencyId}`,
      );
    }

    const emergency = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(CAST(${brand.id} AS text), 0))
      `);
      const transactionConflict = await tx.storeEmergencyTarget.findFirst({
        where: {
          shopId: { in: shops.map(shop => shop.id) },
          emergency: { status: { in: ACTIVE_STATUSES } },
        },
        select: { shop: { select: { shopId: true } }, emergencyId: true },
      });
      if (transactionConflict) {
        throw new BadRequestException(
          `Store ${transactionConflict.shop.shopId} already belongs to active emergency ${transactionConflict.emergencyId}`,
        );
      }
      const created = await tx.storeEmergency.create({
        data: {
          brandId: brand.id,
          mode: dto.mode,
          requestedIds,
          reason: dto.reason.trim(),
          endsAt: dto.endsAt,
          createdById,
          targets: { create: shops.map(shop => ({ shopId: shop.id })) },
        },
      });
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: created.id,
          type: 'emergency_created',
          phase: 'lifecycle',
          outcome: 'requested',
          source: 'user',
          actorId: createdById,
          message: `Emergency created for ${shops.length} store(s)`,
          metadata: {
            mode: dto.mode,
            targetCount: shops.length,
            scheduledReopeningAt: dto.endsAt.toISOString(),
          },
          occurredAt: created.createdAt,
        }),
      });
      return created;
    }, { maxWait: 10_000, timeout: 30_000 });

    const jobData: StoreEmergencyJobData = {
      emergencyId: emergency.id,
      action: 'offline',
      source: 'user',
      actorId: createdById,
    };
    let queuedJob: Awaited<ReturnType<Queue['add']>>;
    try {
      queuedJob = await this.queue.add('set-store-emergency-status', jobData, {
        jobId: `${emergency.id}-offline`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      const message = sanitizeEmergencyMessage(`Could not enqueue emergency: ${(error as Error).message}`);
      const failedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id: emergency.id },
          data: { status: 'failed', errorMessage: message, finishedAt: failedAt },
        }),
        this.prisma.storeEmergencyTarget.updateMany({
          where: { emergencyId: emergency.id, offlineStatus: { in: ['pending', 'running'] } },
          data: { offlineStatus: 'failed', offlineError: message },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: emergency.id,
            type: 'queue_failed',
            phase: 'system',
            outcome: 'failed',
            source: 'system',
            actorId: createdById,
            message,
            metadata: { action: 'offline' },
            occurredAt: failedAt,
          }),
        }),
      ]);
      throw error;
    }

    const queuedAt = new Date(queuedJob.timestamp);
    try {
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id: emergency.id },
          data: { shutdownQueuedAt: queuedAt },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: emergency.id,
            type: 'shutdown_queued',
            phase: 'shutdown',
            outcome: 'queued',
            source: 'user',
            actorId: createdById,
            message: 'Emergency shutdown queued',
            metadata: { jobId: String(queuedJob.id ?? `${emergency.id}-offline`) },
            occurredAt: queuedAt,
          }),
        }),
      ]);
    } catch (error) {
      this.logger.error(`Shutdown job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
    }
    return this.findOne(emergency.id);
  }

  async list(page = 1, limit = 20, summaryOnly = false) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    if (!summaryOnly) {
      const [emergencies, total] = await Promise.all([
        this.prisma.storeEmergency.findMany({
          include: this.detailInclude(),
          orderBy: { createdAt: 'desc' },
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
        }),
        this.prisma.storeEmergency.count(),
      ]);
      const data = emergencies.map(emergency => ({
        ...emergency,
        errorMessage: emergency.errorMessage ? sanitizeEmergencyMessage(emergency.errorMessage) : null,
        targets: emergency.targets.map(target => this.sanitizeTarget(target)),
        targetCounts: this.countsFromTargets(emergency.targets),
        milestones: this.milestones(emergency),
      }));
      return { data, total, page: safePage, limit: safeLimit };
    }
    const [emergencies, total] = await Promise.all([
      this.prisma.storeEmergency.findMany({
        include: {
          brand: { select: { id: true, brandId: true, brandName: true, country: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          _count: { select: { targets: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.storeEmergency.count(),
    ]);
    const ids = emergencies.map(emergency => emergency.id);
    const grouped = ids.length > 0
      ? await this.prisma.storeEmergencyTarget.groupBy({
        by: ['emergencyId', 'offlineStatus', 'restoreStatus'],
        where: { emergencyId: { in: ids } },
        _count: { _all: true },
      })
      : [];
    const counts = this.countsByEmergency(grouped as TargetCountRow[]);
    const data = emergencies.map(emergency => {
      const { _count, ...item } = emergency;
      return {
        ...item,
        errorMessage: item.errorMessage ? sanitizeEmergencyMessage(item.errorMessage) : null,
        targetCounts: counts.get(emergency.id) ?? this.emptyCounts(_count.targets),
        milestones: this.milestones(item),
      };
    });
    return { data, total, page: safePage, limit: safeLimit };
  }

  async findOne(id: string, includeTargets = true) {
    if (includeTargets) {
      const emergency = await this.prisma.storeEmergency.findUnique({
        where: { id },
        include: this.detailInclude(),
      });
      if (!emergency) throw new NotFoundException('Store emergency not found');
      return {
        ...emergency,
        errorMessage: emergency.errorMessage ? sanitizeEmergencyMessage(emergency.errorMessage) : null,
        targets: emergency.targets.map(target => this.sanitizeTarget(target)),
        targetCounts: this.countsFromTargets(emergency.targets),
        milestones: this.milestones(emergency),
      };
    }
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, brandId: true, brandName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { targets: true } },
      },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    const grouped = await this.prisma.storeEmergencyTarget.groupBy({
      by: ['emergencyId', 'offlineStatus', 'restoreStatus'],
      where: { emergencyId: id },
      _count: { _all: true },
    });
    const { _count, ...item } = emergency;
    const targetCounts = this.countsByEmergency(grouped as TargetCountRow[]).get(id) ?? this.emptyCounts(_count.targets);
    return {
      ...item,
      errorMessage: item.errorMessage ? sanitizeEmergencyMessage(item.errorMessage) : null,
      targetCounts,
      milestones: this.milestones(item),
    };
  }

  async timeline(
    id: string,
    page = 1,
    limit = 100,
    phase?: string,
    source?: string,
    outcome?: string,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));
    this.validateFilter(phase, STORE_EMERGENCY_EVENT_PHASES, 'phase');
    this.validateFilter(source, STORE_EMERGENCY_EVENT_SOURCES, 'source');
    this.validateFilter(outcome, STORE_EMERGENCY_EVENT_OUTCOMES, 'outcome');

    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, brandId: true, brandName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');

    const where: Prisma.StoreEmergencyEventWhereInput = {
      emergencyId: id,
      ...(phase ? { phase: phase as StoreEmergencyEventPhase } : {}),
      ...(source ? { source: source as StoreEmergencyEventSource } : {}),
      ...(outcome ? { outcome: outcome as StoreEmergencyEventOutcome } : {}),
    };
    const [data, total, grouped] = await Promise.all([
      this.prisma.storeEmergencyEvent.findMany({
        where,
        include: {
          actor: { select: { id: true, name: true, email: true } },
          target: {
            select: {
              id: true,
              shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } },
            },
          },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.storeEmergencyEvent.count({ where }),
      this.prisma.storeEmergencyTarget.groupBy({
        by: ['emergencyId', 'offlineStatus', 'restoreStatus'],
        where: { emergencyId: id },
        _count: { _all: true },
      }),
    ]);
    const counts = this.countsByEmergency(grouped as TargetCountRow[]).get(id) ?? this.emptyCounts();
    return {
      emergency: {
        ...emergency,
        errorMessage: emergency.errorMessage ? sanitizeEmergencyMessage(emergency.errorMessage) : null,
      },
      milestones: this.milestones(emergency),
      counts,
      data: data.map(event => ({
        ...event,
        message: event.message ? sanitizeEmergencyMessage(event.message) : null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async targets(
    id: string,
    page = 1,
    limit = 100,
    search?: string,
    phase?: string,
    status?: string,
    errorsOnly?: string,
  ) {
    const exists = await this.prisma.storeEmergency.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Store emergency not found');
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));
    this.validateFilter(phase, TARGET_PHASES, 'phase');
    this.validateFilter(status, TARGET_STATUSES, 'status');
    if (errorsOnly && !['true', 'false'].includes(errorsOnly)) {
      throw new BadRequestException('errorsOnly must be true or false');
    }

    const filters: Prisma.StoreEmergencyTargetWhereInput[] = [];
    const normalizedSearch = search?.trim();
    if (normalizedSearch && normalizedSearch.length > 200) {
      throw new BadRequestException('search must be 200 characters or fewer');
    }
    if (normalizedSearch) {
      filters.push({
        shop: {
          OR: [
            { shopId: { contains: normalizedSearch, mode: 'insensitive' } },
            { appShopId: { contains: normalizedSearch, mode: 'insensitive' } },
            { name: { contains: normalizedSearch, mode: 'insensitive' } },
            { city: { contains: normalizedSearch, mode: 'insensitive' } },
          ],
        },
      });
    }
    if (status && phase === 'shutdown') filters.push({ offlineStatus: status });
    if (status && phase === 'restore') filters.push({ restoreStatus: status });
    if (status && !phase) filters.push({ OR: [{ offlineStatus: status }, { restoreStatus: status }] });
    if (errorsOnly === 'true') {
      if (phase === 'shutdown') {
        filters.push({ OR: [{ offlineStatus: 'failed' }, { offlineError: { not: null } }] });
      } else if (phase === 'restore') {
        filters.push({ OR: [{ restoreStatus: 'failed' }, { restoreError: { not: null } }] });
      } else {
        filters.push({
          OR: [
            { offlineStatus: 'failed' },
            { restoreStatus: 'failed' },
            { offlineError: { not: null } },
            { restoreError: { not: null } },
          ],
        });
      }
    }

    const where: Prisma.StoreEmergencyTargetWhereInput = {
      emergencyId: id,
      ...(filters.length ? { AND: filters } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.storeEmergencyTarget.findMany({
        where,
        include: { shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.storeEmergencyTarget.count({ where }),
    ]);
    return { data: data.map(target => this.sanitizeTarget(target)), total, page: safePage, limit: safeLimit };
  }

  async summary() {
    const [activeEmergencies, storesOffline, storesWithErrors, nextReopening] = await Promise.all([
      this.prisma.storeEmergency.count({ where: { status: { in: LIVE_STATUSES } } }),
      this.prisma.storeEmergencyTarget.count({
        where: { offlineStatus: 'done', restoreStatus: { not: 'done' } },
      }),
      this.prisma.storeEmergencyTarget.count({
        where: { OR: [{ offlineStatus: 'failed' }, { restoreStatus: 'failed' }] },
      }),
      this.prisma.storeEmergency.findFirst({
        where: { status: { in: ['offline', 'partial_success'] }, endsAt: { gt: new Date() } },
        select: { id: true, endsAt: true, brand: { select: { brandName: true } } },
        orderBy: { endsAt: 'asc' },
      }),
    ]);
    return { activeEmergencies, storesOffline, storesWithErrors, nextReopening };
  }

  async updateReopening(id: string, dto: UpdateStoreEmergencyReopeningDto, actorId: string) {
    if (dto.endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('Emergency reopening date must be in the future');
    }
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      select: { id: true, status: true, endsAt: true },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    if (!REOPENING_EDITABLE_STATUSES.includes(emergency.status)) {
      throw new BadRequestException('Reopening time can only be changed before restoration begins');
    }
    const changedAt = new Date();
    await this.prisma.$transaction(async tx => {
      const updated = await tx.storeEmergency.updateMany({
        where: { id, status: { in: REOPENING_EDITABLE_STATUSES }, endsAt: emergency.endsAt },
        data: { endsAt: dto.endsAt },
      });
      if (updated.count === 0) throw new BadRequestException('Emergency is already changing status');
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: id,
          type: 'reopening_rescheduled',
          phase: 'schedule',
          outcome: 'rescheduled',
          source: 'user',
          actorId,
          message: 'Scheduled reopening time changed',
          metadata: {
            previousEndsAt: emergency.endsAt.toISOString(),
            newEndsAt: dto.endsAt.toISOString(),
          },
          occurredAt: changedAt,
        }),
      });
    });
    return this.findOne(id);
  }

  async restoreNow(id: string, actorId: string) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        endsAt: true,
        restoreRequestedAt: true,
        restoreQueuedAt: true,
        finishedAt: true,
      },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    if (!['offline', 'partial_success'].includes(emergency.status)) {
      throw new BadRequestException('Only an active offline emergency can be restored immediately');
    }
    const requestedAt = new Date();
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.storeEmergency.updateMany({
        where: { id, status: { in: ['offline', 'partial_success'] } },
        data: {
          status: 'restoring',
          errorMessage: null,
          ...(!emergency.restoreRequestedAt ? { restoreRequestedAt: requestedAt } : {}),
        },
      });
      if (claimed.count === 0) throw new BadRequestException('Emergency is already changing status');
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: id,
          type: 'restore_requested',
          phase: 'restore',
          outcome: 'requested',
          source: 'user',
          actorId,
          message: 'Immediate store reopening requested',
          metadata: { trigger: 'manual', previousScheduledReopeningAt: emergency.endsAt.toISOString() },
          occurredAt: requestedAt,
        }),
      });
    });

    const jobData: StoreEmergencyJobData = { emergencyId: id, action: 'restore', source: 'user', actorId };
    let queuedJob: Awaited<ReturnType<Queue['add']>>;
    try {
      queuedJob = await this.queue.add('set-store-emergency-status', jobData, {
        jobId: `${id}-restore`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      const message = sanitizeEmergencyMessage(`Could not enqueue immediate restore: ${(error as Error).message}`);
      const failedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id },
          data: {
            status: emergency.status,
            restoreQueuedAt: emergency.restoreQueuedAt,
            finishedAt: emergency.finishedAt,
            errorMessage: message,
          },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: id,
            type: 'queue_failed',
            phase: 'system',
            outcome: 'failed',
            source: 'system',
            actorId,
            message,
            metadata: { action: 'restore', trigger: 'manual' },
            occurredAt: failedAt,
          }),
        }),
      ]);
      throw error;
    }

    const queuedAt = new Date(queuedJob.timestamp);
    try {
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id },
          data: { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: id,
            type: 'restore_queued',
            phase: 'restore',
            outcome: 'queued',
            source: 'user',
            actorId,
            message: 'Immediate store reopening queued',
            metadata: { trigger: 'manual', jobId: String(queuedJob.id ?? `${id}-restore`) },
            occurredAt: queuedAt,
          }),
        }),
      ]);
    } catch (error) {
      this.logger.error(`Restore job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
    }
    return this.findOne(id);
  }

  async retryFailures(id: string, actorId: string) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      include: { targets: { select: { id: true, shopId: true, offlineStatus: true, restoreStatus: true } } },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');

    const offlineRetry = ['failed', 'partial_success'].includes(emergency.status);
    const restoreRetry = ['restore_failed', 'partial_restored'].includes(emergency.status);
    if (!offlineRetry && !restoreRetry) {
      throw new BadRequestException('This emergency has no retryable failed stores');
    }
    if (offlineRetry && emergency.endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('Move the reopening time to the future before retrying the shutdown');
    }

    const conflict = await this.prisma.storeEmergencyTarget.findFirst({
      where: {
        emergencyId: { not: id },
        shopId: { in: emergency.targets.map(target => target.shopId) },
        emergency: { status: { in: ACTIVE_STATUSES } },
      },
      select: { emergencyId: true, shop: { select: { shopId: true } } },
    });
    if (conflict) {
      throw new BadRequestException(`Store ${conflict.shop.shopId} belongs to active emergency ${conflict.emergencyId}`);
    }

    const action = offlineRetry ? 'offline' : 'restore';
    const retryTargets = emergency.targets.filter(target => offlineRetry
      ? target.offlineStatus !== 'done'
      : target.offlineStatus === 'done' && target.restoreStatus !== 'done');
    if (!retryTargets.length) {
      throw new BadRequestException(`No failed ${offlineRetry ? 'shutdown' : 'restoration'} target is available to retry`);
    }
    const targetIds = retryTargets.map(target => target.id);
    const requestedAt = new Date();
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(CAST(${emergency.brandId} AS text), 0))
      `);
      const transactionConflict = await tx.storeEmergencyTarget.findFirst({
        where: {
          emergencyId: { not: id },
          shopId: { in: emergency.targets.map(target => target.shopId) },
          emergency: { status: { in: ACTIVE_STATUSES } },
        },
        select: { emergencyId: true, shop: { select: { shopId: true } } },
      });
      if (transactionConflict) {
        throw new BadRequestException(
          `Store ${transactionConflict.shop.shopId} belongs to active emergency ${transactionConflict.emergencyId}`,
        );
      }
      if (offlineRetry) {
        const claimed = await tx.storeEmergency.updateMany({
          where: { id, status: emergency.status },
          data: { status: 'pending', errorMessage: null, finishedAt: null },
        });
        if (claimed.count === 0) throw new BadRequestException('Emergency is already changing status');
        await tx.storeEmergencyTarget.updateMany({
          where: { id: { in: targetIds }, offlineStatus: { not: 'done' } },
          data: { offlineStatus: 'pending', offlineError: null },
        });
      } else {
        const claimed = await tx.storeEmergency.updateMany({
          where: { id, status: emergency.status },
          data: {
            status: 'restoring',
            errorMessage: null,
            finishedAt: null,
            ...(!emergency.restoreRequestedAt ? { restoreRequestedAt: requestedAt } : {}),
          },
        });
        if (claimed.count === 0) throw new BadRequestException('Emergency is already changing status');
        await tx.storeEmergencyTarget.updateMany({
          where: { id: { in: targetIds }, offlineStatus: 'done', restoreStatus: { not: 'done' } },
          data: { restoreStatus: 'pending', restoreError: null },
        });
      }
      await tx.storeEmergencyEvent.create({
        data: emergencyEventData({
          emergencyId: id,
          type: 'retry_requested',
          phase: action === 'offline' ? 'shutdown' : 'restore',
          outcome: 'requested',
          source: 'user',
          actorId,
          message: `Retry requested for ${targetIds.length} failed store(s)`,
          metadata: { action, targetCount: targetIds.length, previousStatus: emergency.status },
          occurredAt: requestedAt,
        }),
      });
    }, { maxWait: 10_000, timeout: 30_000 });

    const jobData: StoreEmergencyJobData = {
      emergencyId: id,
      action,
      source: 'user',
      actorId,
      retry: true,
    };
    let queuedJob: Awaited<ReturnType<Queue['add']>>;
    try {
      queuedJob = await this.queue.add('set-store-emergency-status', jobData, {
        jobId: `${id}-${action}-retry-${Date.now()}`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      const message = sanitizeEmergencyMessage(`Could not enqueue emergency retry: ${(error as Error).message}`);
      const failedAt = new Date();
      await this.prisma.$transaction(async tx => {
        await tx.storeEmergency.update({
          where: { id },
          data: {
            status: emergency.status,
            errorMessage: message,
            finishedAt: emergency.finishedAt,
          },
        });
        await tx.storeEmergencyTarget.updateMany({
          where: { id: { in: targetIds } },
          data: offlineRetry
            ? { offlineStatus: 'failed', offlineError: 'Emergency retry could not be enqueued' }
            : { restoreStatus: 'failed', restoreError: 'Emergency retry could not be enqueued' },
        });
        await tx.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: id,
            type: 'queue_failed',
            phase: 'system',
            outcome: 'failed',
            source: 'system',
            actorId,
            message,
            metadata: { action, retry: true, targetCount: targetIds.length },
            occurredAt: failedAt,
          }),
        });
      });
      throw error;
    }

    const queuedAt = new Date(queuedJob.timestamp);
    try {
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id },
          data: action === 'offline'
            ? { ...(!emergency.shutdownQueuedAt ? { shutdownQueuedAt: queuedAt } : {}) }
            : { ...(!emergency.restoreQueuedAt ? { restoreQueuedAt: queuedAt } : {}) },
        }),
        this.prisma.storeEmergencyEvent.create({
          data: emergencyEventData({
            emergencyId: id,
            type: action === 'offline' ? 'shutdown_queued' : 'restore_queued',
            phase: action === 'offline' ? 'shutdown' : 'restore',
            outcome: 'queued',
            source: 'user',
            actorId,
            message: `Retry queued for ${targetIds.length} failed store(s)`,
            metadata: { retry: true, targetCount: targetIds.length, jobId: String(queuedJob.id ?? '') },
            occurredAt: queuedAt,
          }),
        }),
      ]);
    } catch (error) {
      this.logger.error(`Retry job ${String(queuedJob.id ?? '')} was queued but its audit event could not be persisted: ${(error as Error).message}`);
    }
    return this.findOne(id);
  }

  private detailInclude() {
    return {
      brand: { select: { id: true, brandId: true, brandName: true, country: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      targets: {
        include: { shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } } },
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }

  private sanitizeTarget<T extends { offlineError: string | null; restoreError: string | null }>(target: T): T {
    return {
      ...target,
      offlineError: target.offlineError ? sanitizeEmergencyMessage(target.offlineError) : null,
      restoreError: target.restoreError ? sanitizeEmergencyMessage(target.restoreError) : null,
    };
  }

  private milestones(emergency: {
    createdAt: Date;
    shutdownQueuedAt: Date | null;
    startedAt: Date | null;
    shutdownFinishedAt: Date | null;
    endsAt: Date;
    restoreRequestedAt: Date | null;
    restoreQueuedAt: Date | null;
    restoreStartedAt: Date | null;
    restoreFinishedAt: Date | null;
    finishedAt: Date | null;
  }) {
    return {
      createdAt: emergency.createdAt,
      shutdownQueuedAt: emergency.shutdownQueuedAt,
      shutdownStartedAt: emergency.startedAt,
      shutdownFinishedAt: emergency.shutdownFinishedAt,
      scheduledReopeningAt: emergency.endsAt,
      restoreRequestedAt: emergency.restoreRequestedAt,
      restoreQueuedAt: emergency.restoreQueuedAt,
      restoreStartedAt: emergency.restoreStartedAt,
      restoreFinishedAt: emergency.restoreFinishedAt,
      finishedAt: emergency.finishedAt,
    };
  }

  private countsByEmergency(rows: TargetCountRow[]) {
    const map = new Map<string, StoreEmergencyTargetCounts>();
    for (const row of rows) {
      const counts = map.get(row.emergencyId) ?? this.emptyCounts();
      const amount = row._count._all;
      counts.total += amount;
      if (row.offlineStatus === 'done') counts.shutdownSucceeded += amount;
      else if (row.offlineStatus === 'failed') counts.shutdownFailed += amount;
      else counts.shutdownPending += amount;
      if (row.restoreStatus === 'done') counts.restoreSucceeded += amount;
      else if (row.restoreStatus === 'failed') counts.restoreFailed += amount;
      else if (row.offlineStatus === 'done') counts.restorePending += amount;
      map.set(row.emergencyId, counts);
    }
    return map;
  }

  private countsFromTargets(targets: Array<{ offlineStatus: string; restoreStatus: string }>) {
    const counts = this.emptyCounts();
    for (const target of targets) {
      counts.total += 1;
      if (target.offlineStatus === 'done') counts.shutdownSucceeded += 1;
      else if (target.offlineStatus === 'failed') counts.shutdownFailed += 1;
      else counts.shutdownPending += 1;
      if (target.restoreStatus === 'done') counts.restoreSucceeded += 1;
      else if (target.restoreStatus === 'failed') counts.restoreFailed += 1;
      else if (target.offlineStatus === 'done') counts.restorePending += 1;
    }
    return counts;
  }

  private emptyCounts(total = 0): StoreEmergencyTargetCounts {
    return {
      total,
      shutdownSucceeded: 0,
      shutdownFailed: 0,
      shutdownPending: total,
      restoreSucceeded: 0,
      restoreFailed: 0,
      restorePending: 0,
    };
  }

  private validateFilter(value: string | undefined, allowed: readonly string[], label: string) {
    if (value && !allowed.includes(value)) {
      throw new BadRequestException(`${label} must be one of: ${allowed.join(', ')}`);
    }
  }
}
