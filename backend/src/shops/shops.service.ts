import { Injectable, NotFoundException } from '@nestjs/common';
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
}
