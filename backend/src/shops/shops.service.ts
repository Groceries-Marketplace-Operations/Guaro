import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { UpdateShopDto } from './dto/update-shop.dto';

const SHOP_INCLUDE = {
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  schedules: { orderBy: { dia: 'asc' as const } },
} as const;

@Injectable()
export class ShopsService {
  constructor(private prisma: PrismaService) {}

  findAll(brandId?: string) {
    return this.prisma.shop.findMany({
      where: { deletedAt: null, ...(brandId && { brandId }) },
      include: SHOP_INCLUDE,
      orderBy: { shopId: 'asc' },
    });
  }

  async findOne(id: string) {
    const shop = await this.prisma.shop.findUnique({ where: { id }, include: SHOP_INCLUDE });
    if (!shop || shop.deletedAt) throw new NotFoundException('Shop no encontrada');
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
      data: { shopId, dia: dto.dia, apertura: toDate(dto.apertura), cierre: toDate(dto.cierre) },
    });
  }

  async removeSchedule(shopId: string, scheduleId: string) {
    await this.findOne(shopId);
    return this.prisma.schedule.delete({ where: { id: scheduleId } });
  }
}
