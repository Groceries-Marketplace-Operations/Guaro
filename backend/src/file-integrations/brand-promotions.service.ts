import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BrandPromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    brandId: string,
    params: { page?: number; limit?: number; q?: string; shopExternalId?: string; activityType?: string },
  ) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const q = params.q?.trim();
    const shopExternalId = params.shopExternalId?.trim();
    const parsedActivityType = params.activityType?.trim() === '' || params.activityType === undefined
      ? undefined
      : Number(params.activityType);
    const activityType = parsedActivityType !== undefined && Number.isInteger(parsedActivityType)
      ? parsedActivityType
      : undefined;

    const matchingShops = q ? await this.prisma.shop.findMany({
      where: {
        brandId,
        deletedAt: null,
        OR: [
          { shopId: { contains: q, mode: 'insensitive' } },
          { appShopId: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { appShopId: true },
      take: 500,
    }) : [];

    const brandScope: Prisma.StorePromotionWhereInput = {
      sftpApplication: { brandId, active: true, deletedAt: null },
    };
    const where: Prisma.StorePromotionWhereInput = {
      ...brandScope,
      ...(shopExternalId ? { shopExternalId } : {}),
      ...(activityType !== undefined ? { activityType } : {}),
      ...(q ? {
        OR: [
          { shopExternalId: { contains: q, mode: 'insensitive' } },
          { activityId: { contains: q, mode: 'insensitive' } },
          { activityName: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { sourceFile: { contains: q, mode: 'insensitive' } },
          ...(matchingShops.length ? [{ shopExternalId: { in: matchingShops.map(shop => shop.appShopId) } }] : []),
        ],
      } : {}),
    };

    const [rows, total, distinctStores, lastFetched] = await Promise.all([
      this.prisma.storePromotion.findMany({
        where,
        include: { sftpApplication: { select: { id: true, name: true } } },
        orderBy: [{ fetchedAt: 'desc' }, { activityId: 'asc' }, { sku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.storePromotion.count({ where }),
      this.prisma.storePromotion.findMany({
        where: brandScope,
        select: { shopExternalId: true },
        distinct: ['shopExternalId'],
      }),
      this.prisma.storePromotion.aggregate({ where: brandScope, _max: { fetchedAt: true } }),
    ]);

    const appShopIds = [...new Set(rows.map(row => row.shopExternalId))];
    const shops = appShopIds.length ? await this.prisma.shop.findMany({
      where: { brandId, deletedAt: null, appShopId: { in: appShopIds } },
      select: { id: true, shopId: true, appShopId: true, name: true, city: true },
    }) : [];
    const shopByAppId = new Map(shops.map(shop => [shop.appShopId, shop]));

    return {
      data: rows.map(row => ({
        ...row,
        sourceAccount: row.sftpApplication.name,
        sftpApplication: undefined,
        shop: shopByAppId.get(row.shopExternalId) ?? null,
      })),
      total,
      page,
      limit,
      storesWithPromotions: distinctStores.length,
      lastFetchedAt: lastFetched._max.fetchedAt,
    };
  }
}
