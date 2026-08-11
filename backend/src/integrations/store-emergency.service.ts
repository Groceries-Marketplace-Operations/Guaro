import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreEmergencyDto } from './dto/create-store-emergency.dto';
import { UpdateStoreEmergencyReopeningDto } from './dto/update-store-emergency-reopening.dto';

const ACTIVE_STATUSES = ['pending', 'running', 'offline', 'partial_success', 'restoring', 'partial_restored', 'restore_failed'];
const REOPENING_EDITABLE_STATUSES = ['pending', 'running', 'offline', 'partial_success'];

@Injectable()
export class StoreEmergencyService {
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

    const emergency = await this.prisma.storeEmergency.create({
      data: {
        brandId: brand.id,
        mode: dto.mode,
        requestedIds,
        reason: dto.reason.trim(),
        endsAt: dto.endsAt,
        createdById,
        targets: { create: shops.map(shop => ({ shopId: shop.id })) },
      },
      include: this.include(),
    });
    try {
      await this.queue.add('set-store-emergency-status', { emergencyId: emergency.id, action: 'offline' }, {
        jobId: `${emergency.id}-offline`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      await this.prisma.storeEmergency.update({
        where: { id: emergency.id },
        data: { status: 'failed', errorMessage: `Could not enqueue emergency: ${(error as Error).message}`, finishedAt: new Date() },
      });
      throw error;
    }
    return emergency;
  }

  async list(page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await Promise.all([
      this.prisma.storeEmergency.findMany({
        include: this.include(),
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.storeEmergency.count(),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  async findOne(id: string) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    return emergency;
  }

  async summary() {
    const [activeEmergencies, storesOffline, storesWithErrors, nextReopening] = await Promise.all([
      this.prisma.storeEmergency.count({ where: { status: { in: ACTIVE_STATUSES } } }),
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

  async updateReopening(id: string, dto: UpdateStoreEmergencyReopeningDto) {
    if (dto.endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('Emergency reopening date must be in the future');
    }
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    if (!REOPENING_EDITABLE_STATUSES.includes(emergency.status)) {
      throw new BadRequestException('Reopening time can only be changed before restoration begins');
    }
    const updated = await this.prisma.storeEmergency.updateMany({
      where: { id, status: { in: REOPENING_EDITABLE_STATUSES } },
      data: { endsAt: dto.endsAt },
    });
    if (updated.count === 0) {
      throw new BadRequestException('Emergency is already changing status');
    }
    return this.findOne(id);
  }

  async restoreNow(id: string) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!emergency) throw new NotFoundException('Store emergency not found');
    if (!['offline', 'partial_success'].includes(emergency.status)) {
      throw new BadRequestException('Only an active offline emergency can be restored immediately');
    }
    const claimed = await this.prisma.storeEmergency.updateMany({
      where: { id, status: { in: ['offline', 'partial_success'] } },
      data: { status: 'restoring', endsAt: new Date(), errorMessage: null },
    });
    if (claimed.count === 0) throw new BadRequestException('Emergency is already changing status');
    try {
      await this.queue.add('set-store-emergency-status', { emergencyId: id, action: 'restore' }, {
        jobId: `${id}-restore`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      await this.prisma.storeEmergency.update({
        where: { id },
        data: { status: emergency.status, errorMessage: `Could not enqueue immediate restore: ${(error as Error).message}` },
      });
      throw error;
    }
    return this.findOne(id);
  }

  async retryFailures(id: string) {
    const emergency = await this.prisma.storeEmergency.findUnique({
      where: { id },
      include: { targets: { select: { shopId: true } } },
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
    await this.prisma.$transaction(async tx => {
      if (offlineRetry) {
        const failedTargets = await tx.storeEmergencyTarget.updateMany({
          where: { emergencyId: id, offlineStatus: 'failed' },
          data: { offlineStatus: 'pending', offlineError: null },
        });
        if (!failedTargets.count) throw new BadRequestException('No failed shutdown target is available to retry');
        await tx.storeEmergency.update({
          where: { id },
          data: { status: 'pending', errorMessage: null, finishedAt: null },
        });
      } else {
        const failedTargets = await tx.storeEmergencyTarget.updateMany({
          where: { emergencyId: id, offlineStatus: 'done', restoreStatus: 'failed' },
          data: { restoreStatus: 'pending', restoreError: null },
        });
        if (!failedTargets.count) throw new BadRequestException('No failed restoration target is available to retry');
        await tx.storeEmergency.update({
          where: { id },
          data: { status: 'restoring', errorMessage: null, finishedAt: null },
        });
      }
    });

    try {
      await this.queue.add('set-store-emergency-status', { emergencyId: id, action }, {
        jobId: `${id}-${action}-retry-${Date.now()}`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.storeEmergency.update({
          where: { id },
          data: {
            status: emergency.status,
            errorMessage: `Could not enqueue emergency retry: ${(error as Error).message}`,
          },
        }),
        this.prisma.storeEmergencyTarget.updateMany({
          where: offlineRetry
            ? { emergencyId: id, offlineStatus: 'pending' }
            : { emergencyId: id, offlineStatus: 'done', restoreStatus: 'pending' },
          data: offlineRetry
            ? { offlineStatus: 'failed', offlineError: 'Emergency retry could not be enqueued' }
            : { restoreStatus: 'failed', restoreError: 'Emergency retry could not be enqueued' },
        }),
      ]);
      throw error;
    }
    return this.findOne(id);
  }

  private include() {
    return {
      brand: { select: { id: true, brandId: true, brandName: true, country: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      targets: {
        include: { shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } } },
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }
}
