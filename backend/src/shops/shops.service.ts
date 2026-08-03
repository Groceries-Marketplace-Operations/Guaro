import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { UpdateShopDto } from './dto/update-shop.dto';

const SHOP_INCLUDE = {
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  schedules: { orderBy: { day: 'asc' as const } },
} as const;

@Injectable()
export class ShopsService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters: { page?: number; limit?: number; q?: string; brandId?: string; status?: ShopStatus } = {}) {
    const { page = 1, limit = 25, q, brandId, status } = filters;
    const skip = (page - 1) * limit;
    const where: Prisma.ShopWhereInput = { deletedAt: null };
    if (brandId) where.brandId = brandId;
    if (status) where.status = status;
    if (q) where.OR = [
      { shopId:    { contains: q, mode: 'insensitive' } },
      { appShopId: { contains: q, mode: 'insensitive' } },
      { city:      { contains: q, mode: 'insensitive' } },
      { brand: { brandName: { contains: q, mode: 'insensitive' } } },
    ];
    const [data, total] = await Promise.all([
      this.prisma.shop.findMany({ where, include: SHOP_INCLUDE, orderBy: { shopId: 'asc' }, skip, take: limit }),
      this.prisma.shop.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const shop = await this.prisma.shop.findUnique({ where: { id }, include: SHOP_INCLUDE });
    if (!shop || shop.deletedAt) throw new NotFoundException('Shop not found');
    return shop;
  }

  create(dto: CreateShopDto, createdById: string) {
    const { latitude, longitude, ...rest } = dto;
    return this.prisma.shop.create({
      data: {
        ...rest,
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        createdById,
      },
      include: SHOP_INCLUDE,
    });
  }

  generateImportTemplate() {
    return '\uFEFFshopId,appShopId,city,status\r\n5764607795237028465,STORE_001,Ciudad de Mexico,lead\r\n';
  }

  async createBatch(shops: CreateShopDto[], createdById: string) {
    const normalized = shops.map(shop => ({
      shopId: shop.shopId.trim(),
      appShopId: shop.appShopId.trim(),
      brandId: shop.brandId,
      city: shop.city?.trim() || null,
      status: shop.status ?? ShopStatus.lead,
      latitude: shop.latitude ? parseFloat(shop.latitude) : null,
      longitude: shop.longitude ? parseFloat(shop.longitude) : null,
      createdById,
    }));
    const duplicateShopIds = this.duplicates(normalized.map(shop => shop.shopId));
    const duplicateAppShopIds = this.duplicates(normalized.map(shop => `${shop.brandId}:${shop.appShopId}`));
    if (duplicateShopIds.length > 0) {
      throw new BadRequestException(`Duplicated shopId in CSV: ${duplicateShopIds.slice(0, 10).join(', ')}`);
    }
    if (duplicateAppShopIds.length > 0) {
      throw new BadRequestException(
        `Duplicated appShopId for the same brand in CSV: ${duplicateAppShopIds.slice(0, 10).map(value => value.split(':').slice(1).join(':')).join(', ')}`,
      );
    }

    return this.prisma.$transaction(async tx => {
      const brandIds = [...new Set(normalized.map(shop => shop.brandId))];
      const brands = await tx.brand.findMany({
        where: { id: { in: brandIds }, deletedAt: null },
        select: { id: true },
      });
      const foundBrandIds = new Set(brands.map(brand => brand.id));
      const missingBrandIds = brandIds.filter(id => !foundBrandIds.has(id));
      if (missingBrandIds.length > 0) throw new BadRequestException(`Brand not found: ${missingBrandIds.join(', ')}`);

      const appIdsByBrand = new Map<string, string[]>();
      for (const shop of normalized) {
        appIdsByBrand.set(shop.brandId, [...(appIdsByBrand.get(shop.brandId) ?? []), shop.appShopId]);
      }
      const existing = await tx.shop.findMany({
        where: {
          OR: [
            { shopId: { in: normalized.map(shop => shop.shopId) } },
            ...[...appIdsByBrand.entries()].map(([brandId, appShopIds]) => ({
              brandId,
              appShopId: { in: appShopIds },
            })),
          ],
        },
        select: { shopId: true, appShopId: true, brandId: true },
      });
      if (existing.length > 0) {
        throw new ConflictException(
          `CSV contains stores that already exist: ${existing.slice(0, 10).map(shop => shop.shopId).join(', ')}`,
        );
      }

      await tx.shop.createMany({ data: normalized });
      return tx.shop.findMany({
        where: { shopId: { in: normalized.map(shop => shop.shopId) } },
        include: SHOP_INCLUDE,
        orderBy: { shopId: 'asc' },
      });
    });
  }

  async update(id: string, dto: UpdateShopDto) {
    await this.findOne(id);
    const { latitude, longitude, ...rest } = dto;
    return this.prisma.shop.update({
      where: { id },
      data: {
        ...rest,
        ...(latitude !== undefined && { latitude: parseFloat(latitude) }),
        ...(longitude !== undefined && { longitude: parseFloat(longitude) }),
      },
      include: SHOP_INCLUDE,
    });
  }

  async batchUpdateStatus(ids: string[], status: ShopStatus) {
    if (!ids?.length) return { updated: 0 };
    const { count } = await this.prisma.shop.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { status },
    });
    return { updated: count };
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.shop.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  async addSchedule(shopId: string, dto: CreateScheduleDto) {
    await this.findOne(shopId);
    const toDate = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      const d = new Date(0);
      d.setUTCHours(h, m, 0, 0);
      return d;
    };
    return this.prisma.schedule.create({
      data: { shopId, day: dto.day, openTime: toDate(dto.openTime), closeTime: toDate(dto.closeTime) },
    });
  }

  async removeSchedule(shopId: string, scheduleId: string) {
    await this.findOne(shopId);
    return this.prisma.schedule.delete({ where: { id: scheduleId } });
  }

  private duplicates(values: string[]) {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    }
    return [...duplicated];
  }
}
