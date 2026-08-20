import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutoOpenStoreInclusionFilter,
  ListAutoOpenStoresDto,
} from './dto/list-auto-open-stores.dto';

// Product decision: partial_restored and restore_failed are intentionally not
// live emergencies for Auto Open. Keep every preview and execution query on
// this shared policy so the UI cannot drift from the worker.
export const LIVE_AUTO_OPEN_EMERGENCY_STATUSES = [
  'pending',
  'running',
  'offline',
  'partial_success',
  'restoring',
] as const;

export type AutoOpenStoreInclusion = 'included' | 'emergency' | 'configuration';
export type AutoOpenEmergencyScope = 'brand' | 'store';

export interface AutoOpenStoreSummary {
  totalStores: number;
  includedStores: number;
  emergencyProtectedStores: number;
  configurationBlockedStores: number;
  calculatedAt: string;
}

export interface AutoOpenSummaryIndex {
  byPool: Map<string, AutoOpenStoreSummary>;
  byPoolBrand: Map<string, AutoOpenStoreSummary>;
  activeApplicationBrandIds: Set<string>;
  allBrandProtectedBrandIds: Set<string>;
  targetedProtectedShopIds: Set<string>;
  calculatedAt: string;
}

export function autoOpenPoolBrandSummaryKey(poolId: string, brandId: string) {
  return `${poolId}:${brandId}`;
}

export function emptyAutoOpenStoreSummary(calculatedAt: string): AutoOpenStoreSummary {
  return {
    totalStores: 0,
    includedStores: 0,
    emergencyProtectedStores: 0,
    configurationBlockedStores: 0,
    calculatedAt,
  };
}

export function liveAutoOpenEmergencyWhere(): Prisma.StoreEmergencyWhereInput {
  return {
    status: { in: [...LIVE_AUTO_OPEN_EMERGENCY_STATUSES] },
    finishedAt: null,
  };
}

function configurationBlockedWhere(): Prisma.ShopWhereInput {
  return {
    OR: [
      { brand: { applicationId: null } },
      { brand: { application: { is: { deletedAt: { not: null } } } } },
    ],
  };
}

export interface AutoOpenResolvedInclusion {
  activeApplicationBrandIds: Set<string>;
  allBrandProtectedBrandIds: Set<string>;
  targetedProtectedShopIds: Set<string>;
}

export function autoOpenInclusionWhere(
  inclusion: AutoOpenStoreInclusionFilter,
  resolved: AutoOpenResolvedInclusion,
): Prisma.ShopWhereInput | undefined {
  const activeApplicationBrandIds = [...resolved.activeApplicationBrandIds];
  const allBrandProtectedBrandIds = [...resolved.allBrandProtectedBrandIds];
  const targetedProtectedShopIds = [...resolved.targetedProtectedShopIds];
  if (inclusion === AutoOpenStoreInclusionFilter.configuration) {
    return activeApplicationBrandIds.length
      ? { brandId: { notIn: activeApplicationBrandIds } }
      : configurationBlockedWhere();
  }
  if (inclusion === AutoOpenStoreInclusionFilter.emergency) {
    return {
      brandId: { in: activeApplicationBrandIds },
      OR: [
        { brandId: { in: allBrandProtectedBrandIds } },
        { id: { in: targetedProtectedShopIds } },
      ],
    };
  }
  if (inclusion === AutoOpenStoreInclusionFilter.included) {
    return {
      brandId: { in: activeApplicationBrandIds, notIn: allBrandProtectedBrandIds },
      id: { notIn: targetedProtectedShopIds },
    };
  }
  return undefined;
}

export function buildAutoOpenStoreWhere(
  poolId: string,
  query: Pick<ListAutoOpenStoresDto, 'search' | 'brandId' | 'inclusion'>,
  resolved: AutoOpenResolvedInclusion,
): Prisma.ShopWhereInput {
  const filters: Prisma.ShopWhereInput[] = [
    {
      deletedAt: null,
      brand: {
        deletedAt: null,
        autoOpenPoolBrands: { some: { poolId } },
      },
    },
  ];

  if (query.brandId) filters.push({ brandId: query.brandId });
  if (query.search) {
    filters.push({
      OR: [
        { shopId: { contains: query.search, mode: 'insensitive' } },
        { appShopId: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
        { brand: { brandName: { contains: query.search, mode: 'insensitive' } } },
        { brand: { brandId: { contains: query.search, mode: 'insensitive' } } },
      ],
    });
  }
  const inclusion = autoOpenInclusionWhere(query.inclusion, resolved);
  if (inclusion) filters.push(inclusion);
  return { AND: filters };
}

@Injectable()
export class AutoOpenSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  async summarizePools(poolIds: string[], calculatedAt = new Date()): Promise<AutoOpenSummaryIndex> {
    const calculatedAtIso = calculatedAt.toISOString();
    const byPool = new Map(poolIds.map(poolId => [
      poolId,
      emptyAutoOpenStoreSummary(calculatedAtIso),
    ]));
    const byPoolBrand = new Map<string, AutoOpenStoreSummary>();
    if (!poolIds.length) {
      return {
        byPool,
        byPoolBrand,
        activeApplicationBrandIds: new Set(),
        allBrandProtectedBrandIds: new Set(),
        targetedProtectedShopIds: new Set(),
        calculatedAt: calculatedAtIso,
      };
    }

    const memberships = await this.prisma.autoOpenPoolBrand.findMany({
      where: {
        poolId: { in: poolIds },
        brand: { deletedAt: null },
      },
      select: {
        poolId: true,
        brandId: true,
        brand: {
          select: {
            application: { select: { deletedAt: true } },
            _count: { select: { shops: { where: { deletedAt: null } } } },
          },
        },
      },
    });
    const activeApplicationBrandIds = [...new Set(memberships
      .filter(membership => membership.brand.application?.deletedAt === null)
      .map(membership => membership.brandId))];

    const allBrandEmergencies = activeApplicationBrandIds.length
      ? await this.prisma.storeEmergency.findMany({
        where: {
          brandId: { in: activeApplicationBrandIds },
          mode: 'all_brand',
          ...liveAutoOpenEmergencyWhere(),
        },
        select: { brandId: true },
      })
      : [];
    const allBrandProtected = new Set(allBrandEmergencies.map(emergency => emergency.brandId));
    const targetEligibleBrandIds = activeApplicationBrandIds.filter(brandId => !allBrandProtected.has(brandId));
    const targetedEmergencies = targetEligibleBrandIds.length
      ? await this.prisma.storeEmergencyTarget.findMany({
        where: {
          emergency: {
            brandId: { in: targetEligibleBrandIds },
            mode: 'shop_list',
            ...liveAutoOpenEmergencyWhere(),
          },
          shop: { deletedAt: null, brand: { deletedAt: null } },
        },
        select: {
          shopId: true,
          emergency: { select: { brandId: true } },
          shop: { select: { brandId: true } },
        },
      })
      : [];
    const protectedShopIdsByBrand = new Map<string, Set<string>>();
    const targetedProtectedShopIds = new Set<string>();
    for (const target of targetedEmergencies) {
      if (target.emergency.brandId !== target.shop.brandId) continue;
      const protectedIds = protectedShopIdsByBrand.get(target.shop.brandId) ?? new Set<string>();
      protectedIds.add(target.shopId);
      targetedProtectedShopIds.add(target.shopId);
      protectedShopIdsByBrand.set(target.shop.brandId, protectedIds);
    }

    for (const membership of memberships) {
      const totalStores = membership.brand._count.shops;
      const activeApplication = membership.brand.application?.deletedAt === null;
      const configurationBlockedStores = activeApplication ? 0 : totalStores;
      const emergencyProtectedStores = !activeApplication
        ? 0
        : allBrandProtected.has(membership.brandId)
          ? totalStores
          : Math.min(totalStores, protectedShopIdsByBrand.get(membership.brandId)?.size ?? 0);
      const summary: AutoOpenStoreSummary = {
        totalStores,
        includedStores: totalStores - configurationBlockedStores - emergencyProtectedStores,
        emergencyProtectedStores,
        configurationBlockedStores,
        calculatedAt: calculatedAtIso,
      };
      byPoolBrand.set(autoOpenPoolBrandSummaryKey(membership.poolId, membership.brandId), summary);
      const poolSummary = byPool.get(membership.poolId) ?? emptyAutoOpenStoreSummary(calculatedAtIso);
      poolSummary.totalStores += summary.totalStores;
      poolSummary.includedStores += summary.includedStores;
      poolSummary.emergencyProtectedStores += summary.emergencyProtectedStores;
      poolSummary.configurationBlockedStores += summary.configurationBlockedStores;
      byPool.set(membership.poolId, poolSummary);
    }

    return {
      byPool,
      byPoolBrand,
      activeApplicationBrandIds: new Set(activeApplicationBrandIds),
      allBrandProtectedBrandIds: allBrandProtected,
      targetedProtectedShopIds,
      calculatedAt: calculatedAtIso,
    };
  }

  async listPoolStores(poolId: string, query: ListAutoOpenStoresDto) {
    const calculatedAt = new Date();
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const inclusion = query.inclusion ?? AutoOpenStoreInclusionFilter.all;
    const summaries = await this.summarizePools([poolId], calculatedAt);
    const where = buildAutoOpenStoreWhere(poolId, { ...query, inclusion }, summaries);
    const [shops, total] = await Promise.all([
      this.prisma.shop.findMany({
        where,
        orderBy: [
          { brand: { brandName: 'asc' } },
          { shopId: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          shopId: true,
          appShopId: true,
          name: true,
          city: true,
          status: true,
          brand: {
            select: {
              id: true,
              brandId: true,
              brandName: true,
              country: true,
              application: { select: { id: true, deletedAt: true } },
              storeEmergencies: {
                where: { mode: 'all_brand', ...liveAutoOpenEmergencyWhere() },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { id: true, mode: true, status: true, brandId: true },
              },
            },
          },
          emergencies: {
            where: {
              emergency: { mode: 'shop_list', ...liveAutoOpenEmergencyWhere() },
            },
            orderBy: { createdAt: 'desc' },
            select: {
              emergency: { select: { id: true, mode: true, status: true, brandId: true } },
            },
          },
        },
      }),
      this.prisma.shop.count({ where }),
    ]);

    const data = shops.map(shop => {
      const applicationActive = summaries.activeApplicationBrandIds.has(shop.brand.id);
      const brandEmergency = shop.brand.storeEmergencies[0];
      const storeEmergency = shop.emergencies
        .map(target => target.emergency)
        .find(emergency => emergency.brandId === shop.brand.id);
      let inclusionState: AutoOpenStoreInclusion = 'included';
      let reason: 'missing_active_application' | 'live_brand_emergency' | 'live_store_emergency' | null = null;
      let emergency: {
        id: string;
        mode: string;
        status: string;
        scope: AutoOpenEmergencyScope;
      } | null = null;

      if (!applicationActive) {
        inclusionState = 'configuration';
        reason = 'missing_active_application';
      } else if (summaries.allBrandProtectedBrandIds.has(shop.brand.id)) {
        inclusionState = 'emergency';
        reason = 'live_brand_emergency';
        emergency = brandEmergency
          ? {
            id: brandEmergency.id,
            mode: brandEmergency.mode,
            status: brandEmergency.status,
            scope: 'brand',
          }
          : null;
      } else if (summaries.targetedProtectedShopIds.has(shop.id)) {
        inclusionState = 'emergency';
        reason = 'live_store_emergency';
        emergency = storeEmergency
          ? {
            id: storeEmergency.id,
            mode: storeEmergency.mode,
            status: storeEmergency.status,
            scope: 'store',
          }
          : null;
      }

      return {
        id: shop.id,
        shopId: shop.shopId,
        appShopId: shop.appShopId,
        name: shop.name,
        city: shop.city,
        status: shop.status,
        brand: {
          id: shop.brand.id,
          brandId: shop.brand.brandId,
          brandName: shop.brand.brandName,
          country: shop.brand.country,
        },
        inclusion: inclusionState,
        reason,
        emergency,
      };
    });
    const calculatedAtIso = calculatedAt.toISOString();
    return {
      data,
      total,
      page,
      limit,
      summary: summaries.byPool.get(poolId) ?? emptyAutoOpenStoreSummary(calculatedAtIso),
      summaryScope: 'pool' as const,
      calculatedAt: calculatedAtIso,
    };
  }

  async emergencyProtectionForBatch(brandId: string, shopIds: string[]) {
    const emergencies = await this.prisma.storeEmergency.findMany({
      where: {
        brandId,
        ...liveAutoOpenEmergencyWhere(),
        OR: [
          { mode: 'all_brand' },
          { mode: 'shop_list', targets: { some: { shopId: { in: shopIds } } } },
        ],
      },
      select: {
        mode: true,
        targets: { where: { shopId: { in: shopIds } }, select: { shopId: true } },
      },
    });
    return {
      blockAll: emergencies.some(emergency => emergency.mode === 'all_brand'),
      blockedShopIds: new Set(emergencies.flatMap(emergency => emergency.targets.map(target => target.shopId))),
    };
  }

  async hasLiveEmergency(brandId: string, shopUuid: string) {
    const emergency = await this.prisma.storeEmergency.findFirst({
      where: {
        brandId,
        ...liveAutoOpenEmergencyWhere(),
        OR: [
          { mode: 'all_brand' },
          { mode: 'shop_list', targets: { some: { shopId: shopUuid } } },
        ],
      },
      select: { id: true },
    });
    return emergency !== null;
  }
}
