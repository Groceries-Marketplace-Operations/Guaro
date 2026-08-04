import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateForcedOpenDto } from './dto/create-forced-open.dto';

@Injectable()
export class ForcedOpenService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('forced-open') private readonly queue: Queue,
  ) {}

  async create(dto: CreateForcedOpenDto, createdById: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: dto.brandId },
      select: { id: true, deletedAt: true, applicationId: true },
    });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    if (!brand.applicationId) throw new BadRequestException('The brand has no linked application credentials');

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
    if (shops.length === 0) throw new BadRequestException('No local stores matched this forced opening');
    if (dto.mode === 'shop_list') {
      const found = new Set(shops.map(shop => shop.shopId));
      const missing = requestedIds.filter(shopId => !found.has(shopId));
      if (missing.length > 0) {
        throw new BadRequestException(
          `${missing.length} shop_id value(s) are not stored locally for this brand: ${missing.slice(0, 10).join(', ')}`,
        );
      }
    }

    const operation = await this.prisma.forcedOpenOperation.create({
      data: {
        brandId: brand.id,
        mode: dto.mode,
        requestedIds,
        totalShops: shops.length,
        createdById,
        targets: { create: shops.map(shop => ({ shopId: shop.id })) },
      },
      include: this.include(),
    });
    try {
      await this.queue.add('force-open-stores', { operationId: operation.id }, {
        jobId: operation.id,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      await this.prisma.forcedOpenOperation.update({
        where: { id: operation.id },
        data: { status: 'failed', errorMessage: `Could not enqueue forced opening: ${(error as Error).message}`, finishedAt: new Date() },
      });
      throw error;
    }
    return operation;
  }

  async list(page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await Promise.all([
      this.prisma.forcedOpenOperation.findMany({
        include: this.summaryInclude(),
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.forcedOpenOperation.count(),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  async findOne(id: string) {
    const operation = await this.prisma.forcedOpenOperation.findUnique({ where: { id }, include: this.include() });
    if (!operation) throw new NotFoundException('Forced opening not found');
    return operation;
  }

  private include() {
    return {
      ...this.summaryInclude(),
      targets: {
        include: { shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } } },
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }

  private summaryInclude() {
    return {
      brand: { select: { id: true, brandId: true, brandName: true, country: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    };
  }
}
