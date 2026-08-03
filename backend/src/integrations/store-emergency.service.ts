import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreEmergencyDto } from './dto/create-store-emergency.dto';

const ACTIVE_STATUSES = ['pending', 'running', 'offline', 'partial_success', 'restoring'];

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
