import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { downloadMenu } from '../integrations/auto-turn-off-api.util';
import {
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  COOLDOWN_RETRY_MS,
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';

export interface CatalogMenuItem {
  name: string;
  upc: string | null;
  appItemId: string;
}

interface CatalogShopDetail {
  shopId: string;
  appShopId: string;
  brandId: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
}

interface ApplicationShopDetails {
  details: CatalogShopDetail[];
  totalMappings: number;
  failures: number;
  expiresAt: number;
}

type ContinuationCheck = () => Promise<void> | void;

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['default', 'es_MX', 'es_CO', 'es_CR', 'es', 'name', 'value']) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

export function inferShopCity(detail: Record<string, unknown>): string | null {
  const poi = detail.poi_name && typeof detail.poi_name === 'object'
    ? detail.poi_name as Record<string, unknown>
    : {};
  const direct = textValue(detail.city_name ?? detail.city ?? poi.city_name ?? poi.city);
  if (direct) return direct;

  const location = textValue(detail.poi_name ?? detail.addr);
  const segments = location.split(',').map(segment => segment.trim()).filter(Boolean);
  for (const segment of [...segments].reverse()) {
    const postalCity = /^\d{4,6}\s+(.+)$/u.exec(segment);
    if (postalCity?.[1]) return postalCity[1].trim();
  }
  const countryNames = /^(mexico|méxico|colombia|costa rica|cr|mx|co)$/iu;
  const fallback = [...segments].reverse().find(segment => !countryNames.test(segment));
  return fallback && fallback.length <= 80 ? fallback : null;
}

export function normalizeMenuItems(items: Array<Record<string, unknown>>): CatalogMenuItem[] {
  const unique = new Map<string, CatalogMenuItem>();
  for (const item of items) {
    const appItemId = textValue(item.app_item_id ?? item.appItemId ?? item.ext_id);
    if (!appItemId) continue;
    const name = textValue(item.name ?? item.item_name ?? item.app_item_name) || appItemId;
    const upc = textValue(item.upc ?? item.barcode ?? item.item_barcode) || null;
    unique.set(appItemId, { appItemId, name, upc });
  }
  return [...unique.values()];
}

export function selectMenuSampleShops<T extends { city: string | null; shopId: string }>(shops: T[], perCity = 2): T[] {
  const byCity = new Map<string, T[]>();
  for (const shop of shops) {
    const cityKey = shop.city?.trim().toLocaleLowerCase() || '__unknown__';
    const cityShops = byCity.get(cityKey) ?? [];
    if (cityShops.length < perCity) cityShops.push(shop);
    byCity.set(cityKey, cityShops);
  }
  return [...byCity.values()].flat();
}

@Injectable()
export class CatalogSyncService {
  private readonly applicationShopCache = new Map<string, ApplicationShopDetails>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async syncBrandStores(brandId: string, ensureActive?: ContinuationCheck) {
    await ensureActive?.();
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      include: { application: { select: { appId: true, appSecret: true } } },
    });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

    const appSecret = this.decryptSecret(brand.application.appSecret);
    const applicationShops = await this.fetchApplicationShopDetails(brand.application.appId, appSecret, ensureActive);
    await ensureActive?.();
    if (applicationShops.totalMappings > 0 && applicationShops.details.length === 0) {
      throw new Error('Could not fetch details for any shop in the application');
    }

    const unidentifiedIds = applicationShops.details
      .filter(shop => !shop.brandId)
      .map(shop => shop.shopId);
    const previouslyOwned = unidentifiedIds.length > 0
      ? await this.prisma.shop.findMany({
        where: { brandId: brand.id, shopId: { in: unidentifiedIds }, deletedAt: null },
        select: { shopId: true },
      })
      : [];
    const previouslyOwnedIds = new Set(previouslyOwned.map(shop => shop.shopId));
    const shops = applicationShops.details.filter(shop =>
      shop.brandId === brand.brandId || (!shop.brandId && previouslyOwnedIds.has(shop.shopId)),
    );

    const knownForeignIds = applicationShops.details
      .filter(shop => shop.brandId && shop.brandId !== brand.brandId)
      .map(shop => shop.shopId);
    if (knownForeignIds.length > 0) {
      await ensureActive?.();
      await this.prisma.shop.updateMany({
        where: { brandId: brand.id, shopId: { in: knownForeignIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    const existing = await this.prisma.shop.findMany({
      where: { shopId: { in: shops.map(shop => shop.shopId) } },
      select: { id: true, shopId: true, brandId: true },
    });
    const existingByShopId = new Map(existing.map(shop => [shop.shopId, shop]));

    for (let offset = 0; offset < shops.length; offset += 100) {
      await ensureActive?.();
      const chunk = shops.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.map(shop => {
        const previous = existingByShopId.get(shop.shopId);
        return this.prisma.shop.upsert({
            where: { shopId: shop.shopId },
            create: {
              shopId: shop.shopId,
              appShopId: shop.appShopId,
              name: shop.name,
              brandId: brand.id,
              city: shop.city,
              address: shop.address,
              latitude: shop.latitude,
              longitude: shop.longitude,
              status: 'integrated',
            },
            update: {
              appShopId: shop.appShopId,
              name: shop.name,
              brandId: brand.id,
              city: shop.city ?? undefined,
              address: shop.address ?? undefined,
              latitude: shop.latitude ?? undefined,
              longitude: shop.longitude ?? undefined,
              deletedAt: null,
              ...(previous && previous.brandId !== brand.id ? {
                menuSyncStatus: 'never',
                menuSyncedAt: null,
                menuSyncError: null,
                menuItemCount: 0,
              } : {}),
            },
          });
      }));
    }

    const updated = shops.filter(shop => existingByShopId.has(shop.shopId)).length;
    return {
      brandId: brand.id,
      brandName: brand.brandName,
      totalShops: shops.length,
      created: shops.length - updated,
      updated,
      applicationShops: applicationShops.totalMappings,
      detailFailures: applicationShops.failures,
    };
  }

  async syncShopMenu(shopDatabaseId: string, ensureActive?: ContinuationCheck) {
    await ensureActive?.();
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopDatabaseId },
      include: {
        brand: { include: { application: { select: { appId: true, appSecret: true } } } },
      },
    });
    if (!shop || shop.deletedAt) throw new NotFoundException('Shop not found');
    if (!shop.brand.application) throw new Error(`Brand ${shop.brand.brandName} has no linked application`);

    await this.prisma.shop.update({
      where: { id: shop.id },
      data: { menuSyncStatus: 'running', menuSyncError: null },
    });

    try {
      const appSecret = this.decryptSecret(shop.brand.application.appSecret);
      const authToken = await getAuthToken(shop.brand.application.appId, appSecret, shop.appShopId);
      const menu = await downloadMenu(authToken, async () => ensureActive?.());
      await ensureActive?.();
      const itemCount = await this.replaceShopMenu(shop.id, menu.items, ensureActive);
      return {
        shopId: shop.shopId,
        appShopId: shop.appShopId,
        menuTaskId: menu.taskId,
        itemCount,
      };
    } catch (error) {
      await this.prisma.shop.update({
        where: { id: shop.id },
        data: {
          menuSyncStatus: 'failed',
          menuSyncError: (error as Error).message,
        },
      });
      throw error;
    }
  }

  async replaceShopMenu(
    shopDatabaseId: string,
    rawItems: Array<Record<string, unknown>>,
    ensureActive?: ContinuationCheck,
  ) {
    await ensureActive?.();
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopDatabaseId },
      select: { id: true, brandId: true, shopId: true, city: true },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    const items = normalizeMenuItems(rawItems);
    const now = new Date();

    for (let offset = 0; offset < items.length; offset += 100) {
      await ensureActive?.();
      const chunk = items.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.map(item => this.prisma.brandItem.upsert({
        where: { brandId_appItemId: { brandId: shop.brandId, appItemId: item.appItemId } },
        create: {
          brandId: shop.brandId,
          name: item.name,
          upc: item.upc,
          appItemId: item.appItemId,
          sourceShopId: shop.shopId,
          sourceCity: shop.city,
          lastSeenAt: now,
        },
        update: {
          name: item.name,
          upc: item.upc,
          sourceShopId: shop.shopId,
          sourceCity: shop.city,
          lastSeenAt: now,
        },
      })));
    }
    await this.prisma.shop.update({
      where: { id: shop.id },
      data: {
        menuSyncStatus: 'done',
        menuSyncedAt: now,
        menuSyncError: null,
        menuItemCount: items.length,
      },
    });
    return items.length;
  }

  async syncBrandMenus(
    brandId: string,
    onProgress?: (completed: number, total: number, shopId: string) => Promise<void> | void,
    ensureActive?: ContinuationCheck,
  ) {
    await ensureActive?.();
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        brandName: true,
        shops: {
          where: { deletedAt: null },
          select: { id: true, shopId: true, city: true },
          orderBy: [{ city: 'asc' }, { shopId: 'asc' }],
        },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const sampledShops = selectMenuSampleShops(brand.shops);
    const sampledCities = new Set(brand.shops.map(shop => shop.city?.trim().toLocaleLowerCase() || '__unknown__')).size;
    const syncStartedAt = new Date();
    let cursor = 0;
    let succeeded = 0;
    let totalItems = 0;
    const failures: Array<{ shopId: string; error: string }> = [];
    const concurrency = Math.min(3, Math.max(1, sampledShops.length));

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= sampledShops.length) return;
        const shop = sampledShops[index];
        await ensureActive?.();
        try {
          const result = await this.syncShopMenu(shop.id, ensureActive);
          succeeded++;
          totalItems += result.itemCount;
        } catch (error) {
          await ensureActive?.();
          failures.push({ shopId: shop.shopId, error: (error as Error).message });
        }
        await onProgress?.(index + 1, sampledShops.length, shop.shopId);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (sampledShops.length > 0 && failures.length === 0) {
      await ensureActive?.();
      await this.prisma.brandItem.deleteMany({
        where: { brandId: brand.id, lastSeenAt: { lt: syncStartedAt } },
      });
    }

    return {
      brandId: brand.id,
      brandName: brand.brandName,
      totalShops: sampledShops.length,
      availableShops: brand.shops.length,
      sampledCities,
      shopsSucceeded: succeeded,
      shopsFailed: failures.length,
      totalItems,
      failures: failures.slice(0, 100),
    };
  }

  async listBrandItems(brandId: string, params: { page?: number; limit?: number; q?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const where: Prisma.BrandItemWhereInput = {
      brandId,
      ...(params.q ? {
        OR: [
          { name: { contains: params.q, mode: 'insensitive' } },
          { upc: { contains: params.q } },
          { appItemId: { contains: params.q } },
          { sourceShopId: { contains: params.q } },
          { sourceCity: { contains: params.q, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [data, total, shopsWithMenu, lastSynced] = await Promise.all([
      this.prisma.brandItem.findMany({
        where,
        orderBy: [{ name: 'asc' }, { appItemId: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.brandItem.count({ where }),
      this.prisma.shop.count({ where: { brandId, deletedAt: null, menuSyncStatus: 'done' } }),
      this.prisma.shop.findFirst({
        where: { brandId, deletedAt: null, menuSyncedAt: { not: null } },
        orderBy: { menuSyncedAt: 'desc' },
        select: { menuSyncedAt: true },
      }),
    ]);
    return { data, total, page, limit, shopsWithMenu, lastSyncedAt: lastSynced?.menuSyncedAt ?? null };
  }

  private decryptSecret(encrypted: string) {
    const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
    return encryptionKey ? decrypt(encrypted, encryptionKey) : encrypted;
  }

  private async fetchApplicationShopDetails(
    appId: string,
    appSecret: string,
    ensureActive?: ContinuationCheck,
  ): Promise<ApplicationShopDetails> {
    await ensureActive?.();
    const cached = this.applicationShopCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const mappings = await fetchShopIdMap(appId, appSecret);
    const targets = [...mappings.entries()].map(([shopId, appShopId]) => ({ shopId, appShopId }));
    const details: CatalogShopDetail[] = [];
    let failures = 0;

    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      await ensureActive?.();
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(shop => this.fetchShopDetail(appId, appSecret, shop, ensureActive)));
      await ensureActive?.();
      for (const result of results) {
        if (result.status === 'fulfilled') details.push(result.value);
        else failures++;
      }
      if (offset + BATCH_SIZE < targets.length) await sleep(COOLDOWN_BATCH_MS);
    }

    const result = {
      details,
      totalMappings: targets.length,
      failures,
      expiresAt: Date.now() + 30 * 60_000,
    };
    this.applicationShopCache.set(appId, result);
    return result;
  }

  private async fetchShopDetail(
    appId: string,
    appSecret: string,
    shop: { shopId: string; appShopId: string },
    ensureActive?: ContinuationCheck,
  ): Promise<CatalogShopDetail> {
    let lastError = 'Unknown shop detail error';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ensureActive?.();
        const authToken = await getAuthToken(appId, appSecret, shop.appShopId);
        const endpoint = 'GET /v1/shop/shop/detail';
        const response = await fetchWithEndpointContext(
          endpoint,
          `${DIDI_BASE}/v1/shop/shop/detail?auth_token=${encodeURIComponent(authToken)}`,
        );
        const body = parseJsonKeepingIds(await response.text());
        if (body.errno === 10005) throw new Error(`${endpoint} rate limited (errno=10005)`);
        if (!response.ok || body.errno !== 0 || !body.data) {
          throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
        }
        const detail = body.data as Record<string, unknown>;
        return {
          shopId: shop.shopId,
          appShopId: shop.appShopId,
          brandId: textValue(detail.brand_id) || null,
          name: textValue(detail.name) || null,
          city: inferShopCity(detail),
          address: textValue(detail.addr ?? detail.announce ?? detail.poi_name) || null,
          latitude: textValue(detail.lat) || null,
          longitude: textValue(detail.lng) || null,
        };
      } catch (error) {
        lastError = (error as Error).message;
        if (attempt < 3) await sleep(COOLDOWN_RETRY_MS * attempt);
      }
    }
    throw new Error(`${shop.shopId}: ${lastError}`);
  }
}
