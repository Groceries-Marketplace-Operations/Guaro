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
  latitude: string | null;
  longitude: string | null;
}

interface ApplicationShopDetails {
  details: CatalogShopDetail[];
  totalMappings: number;
  failures: number;
  expiresAt: number;
}

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

@Injectable()
export class CatalogSyncService {
  private readonly applicationShopCache = new Map<string, ApplicationShopDetails>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async syncBrandStores(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      include: { application: { select: { appId: true, appSecret: true } } },
    });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

    const appSecret = this.decryptSecret(brand.application.appSecret);
    const applicationShops = await this.fetchApplicationShopDetails(brand.application.appId, appSecret);
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
      const chunk = shops.slice(offset, offset + 100);
      await this.prisma.$transaction(chunk.flatMap(shop => {
        const previous = existingByShopId.get(shop.shopId);
        return [
          ...(previous && previous.brandId !== brand.id
            ? [this.prisma.brandItem.deleteMany({ where: { shopId: previous.id } })]
            : []),
          this.prisma.shop.upsert({
            where: { shopId: shop.shopId },
            create: {
              shopId: shop.shopId,
              appShopId: shop.appShopId,
              name: shop.name,
              brandId: brand.id,
              city: shop.city,
              latitude: shop.latitude,
              longitude: shop.longitude,
              status: 'integrated',
            },
            update: {
              appShopId: shop.appShopId,
              name: shop.name,
              brandId: brand.id,
              city: shop.city,
              latitude: shop.latitude,
              longitude: shop.longitude,
              deletedAt: null,
              ...(previous && previous.brandId !== brand.id ? {
                menuSyncStatus: 'never',
                menuSyncedAt: null,
                menuSyncError: null,
                menuItemCount: 0,
              } : {}),
            },
          }),
        ];
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

  async syncShopMenu(shopDatabaseId: string) {
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
      const menu = await downloadMenu(authToken, async () => undefined);
      const itemCount = await this.replaceShopMenu(shop.id, menu.items);
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

  async replaceShopMenu(shopDatabaseId: string, rawItems: Array<Record<string, unknown>>) {
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopDatabaseId },
      select: { id: true, brandId: true, appShopId: true },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    const items = normalizeMenuItems(rawItems);
    const now = new Date();

    await this.prisma.brandItem.deleteMany({ where: { shopId: shop.id } });
    for (let offset = 0; offset < items.length; offset += 1000) {
      const chunk = items.slice(offset, offset + 1000);
      await this.prisma.brandItem.createMany({
        data: chunk.map(item => ({
          brandId: shop.brandId,
          shopId: shop.id,
          name: item.name,
          upc: item.upc,
          appItemId: item.appItemId,
          appShopId: shop.appShopId,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      });
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
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        brandName: true,
        shops: {
          where: { deletedAt: null },
          select: { id: true, shopId: true },
          orderBy: { shopId: 'asc' },
        },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    let cursor = 0;
    let succeeded = 0;
    let totalItems = 0;
    const failures: Array<{ shopId: string; error: string }> = [];
    const concurrency = Math.min(3, Math.max(1, brand.shops.length));

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= brand.shops.length) return;
        const shop = brand.shops[index];
        try {
          const result = await this.syncShopMenu(shop.id);
          succeeded++;
          totalItems += result.itemCount;
        } catch (error) {
          failures.push({ shopId: shop.shopId, error: (error as Error).message });
        }
        await onProgress?.(index + 1, brand.shops.length, shop.shopId);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      brandId: brand.id,
      brandName: brand.brandName,
      totalShops: brand.shops.length,
      shopsSucceeded: succeeded,
      shopsFailed: failures.length,
      totalItems,
      failures: failures.slice(0, 100),
    };
  }

  async listBrandItems(brandId: string, params: { page?: number; limit?: number; q?: string; shopId?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const where: Prisma.BrandItemWhereInput = {
      brandId,
      ...(params.shopId ? { shopId: params.shopId } : {}),
      ...(params.q ? {
        OR: [
          { name: { contains: params.q, mode: 'insensitive' } },
          { upc: { contains: params.q } },
          { appItemId: { contains: params.q } },
          { appShopId: { contains: params.q } },
        ],
      } : {}),
    };
    const [data, total, shopsWithMenu, lastSynced] = await Promise.all([
      this.prisma.brandItem.findMany({
        where,
        include: { shop: { select: { id: true, shopId: true, appShopId: true } } },
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

  private async fetchApplicationShopDetails(appId: string, appSecret: string): Promise<ApplicationShopDetails> {
    const cached = this.applicationShopCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const mappings = await fetchShopIdMap(appId, appSecret);
    const targets = [...mappings.entries()].map(([shopId, appShopId]) => ({ shopId, appShopId }));
    const details: CatalogShopDetail[] = [];
    let failures = 0;

    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(shop => this.fetchShopDetail(appId, appSecret, shop)));
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
  ): Promise<CatalogShopDetail> {
    let lastError = 'Unknown shop detail error';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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
          city: textValue(detail.city_name ?? detail.city) || null,
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
