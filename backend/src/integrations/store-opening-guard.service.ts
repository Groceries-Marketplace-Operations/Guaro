import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  storeEmergencyConflict,
  storeEmergencyLiveWhere,
} from './store-emergency-status';

export interface StoreOpeningPermitOptions<T> {
  shopId: string;
  allowedEmergencyId?: string;
  operation: string;
  execute: () => Promise<T>;
}

export interface StoreOpeningPreflightOptions {
  brandId?: string;
  shopIds: string[];
  operation?: string;
}

const BLOCKING_EMERGENCY_SELECT = {
  id: true,
  brandId: true,
  mode: true,
  status: true,
  endsAt: true,
} as const;

@Injectable()
export class StoreOpeningGuardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fast UX preflight only. The per-target permit below is the authoritative
   * concurrency boundary immediately around the provider write.
   */
  async assertCanOpenMany(shopIds: string[], operation?: string): Promise<void>;
  async assertCanOpenMany(options: StoreOpeningPreflightOptions): Promise<void>;
  async assertCanOpenMany(
    input: string[] | StoreOpeningPreflightOptions,
    operationOverride?: string,
  ): Promise<void> {
    const options: StoreOpeningPreflightOptions = Array.isArray(input) ? { shopIds: input } : input;
    const operation = operationOverride ?? options.operation ?? 'open stores';
    const uniqueShopIds = [...new Set(options.shopIds.filter(Boolean))];
    if (uniqueShopIds.length === 0) return;
    const shops = await this.prisma.shop.findMany({
      where: { id: { in: uniqueShopIds }, deletedAt: null },
      select: { id: true, shopId: true, brandId: true },
    });
    if (shops.length === 0) return;
    const byId = new Map(shops.map(shop => [shop.id, shop]));
    const emergency = await this.prisma.storeEmergency.findFirst({
      where: {
        ...storeEmergencyLiveWhere(),
        ...(options.brandId ? { brandId: options.brandId } : {}),
        OR: [
          { mode: 'all_brand', brandId: { in: [...new Set(shops.map(shop => shop.brandId))] } },
          { mode: 'shop_list', targets: { some: { shopId: { in: shops.map(shop => shop.id) } } } },
        ],
      },
      select: {
        ...BLOCKING_EMERGENCY_SELECT,
        targets: {
          where: { shopId: { in: shops.map(shop => shop.id) } },
          select: { shopId: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!emergency) return;
    const blockedShop = emergency.mode === 'all_brand'
      ? shops.find(shop => shop.brandId === emergency.brandId)
      : byId.get(emergency.targets[0]?.shopId);
    throw storeEmergencyConflict({
      operation,
      emergency,
      ...(blockedShop ? { shop: { id: blockedShop.id, shopId: blockedShop.shopId } } : {}),
    });
  }

  /**
   * Shared brand lock allows concurrent openings but excludes emergency
   * create/retry/restore transitions. The provider write intentionally runs
   * while the transaction owns the lock; callers must keep it bounded.
   */
  async withOpeningPermit<T>(options: StoreOpeningPermitOptions<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const shop = await tx.shop.findUnique({
        where: { id: options.shopId },
        select: { id: true, shopId: true, brandId: true, deletedAt: true },
      });
      if (!shop || shop.deletedAt) throw new NotFoundException('Store not found');

      // Reserve enough of the 15-second transaction budget for the caller's
      // bounded provider write; never start it after a long lock wait.
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(hashtextextended(CAST(${shop.brandId} AS text), 0))
      `);
      const emergency = await tx.storeEmergency.findFirst({
        where: storeEmergencyLiveWhere({
          brandId: shop.brandId,
          shopId: shop.id,
          excludeEmergencyId: options.allowedEmergencyId,
        }),
        select: BLOCKING_EMERGENCY_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      if (emergency) {
        throw storeEmergencyConflict({
          operation: options.operation,
          emergency,
          shop: { id: shop.id, shopId: shop.shopId },
        });
      }
      return options.execute();
    }, { maxWait: 5_000, timeout: 15_000 });
  }
}
