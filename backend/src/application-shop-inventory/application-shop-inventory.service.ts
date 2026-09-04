import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApplicationShopInventoryFetchStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { decrypt } from '../common/crypto.util';
import { DidiStoreBindingCoordinator } from '../file-integrations/didi-store-binding-coordinator.service';
import {
  buildListBoundStoresRequest,
  DIDI_LIST_BOUND_STORES_ENDPOINT,
  DIDI_LIST_BOUND_STORES_PATH,
  redactSensitiveText,
} from '../file-integrations/didi-store-bindings.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 45_000;
const CREATE_CHUNK_SIZE = 1_000;
const STALE_RUN_MS = 5 * 60_000;

type JsonRecord = Record<string, unknown>;

export interface RemoteInventoryShop {
  shopId: string;
  appShopId: string;
  shopName: string | null;
  brandExternalId: string | null;
  brandName: string | null;
  city: string | null;
  address: string | null;
}

interface StoredInventoryShop extends RemoteInventoryShop {
  brandSource: 'remote' | 'local' | null;
}

const INVENTORY_INCLUDE = {
  application: {
    select: { id: true, appId: true, appName: true, country: true, deletedAt: true },
  },
  createdBy: { select: { id: true, name: true } },
  lastRequestedBy: { select: { id: true, name: true } },
} satisfies Prisma.ApplicationShopInventoryInclude;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || null;
  }
  if (!value || typeof value !== 'object') return null;
  const object = value as JsonRecord;
  for (const key of ['default', 'es_MX', 'es_CO', 'es_CR', 'es', 'name', 'value']) {
    const nested = object[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return null;
}

export function parseProviderErrno(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonNegativeCount(value: unknown): number | null {
  const parsed = parseProviderErrno(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export function normalizeRemoteInventoryShop(value: unknown): RemoteInventoryShop | null {
  const shop = record(value);
  if (!shop) return null;
  const brand = record(shop.brand ?? shop.brand_info);
  const poi = record(shop.poi_name);
  const shopId = textValue(shop.shop_id);
  const appShopId = textValue(shop.app_shop_id);
  if (!shopId || !appShopId) return null;
  return {
    shopId,
    appShopId,
    shopName: textValue(shop.shop_name ?? shop.name),
    brandExternalId: textValue(shop.brand_id ?? brand?.brand_id ?? brand?.id),
    brandName: textValue(shop.brand_name ?? brand?.brand_name ?? brand?.name),
    city: textValue(shop.city_name ?? shop.city ?? poi?.city_name ?? poi?.city),
    address: textValue(shop.addr ?? shop.address ?? shop.announce ?? shop.poi_name),
  };
}

function safeAuditValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function fetchIsActive(status: ApplicationShopInventoryFetchStatus) {
  return status === ApplicationShopInventoryFetchStatus.queued
    || status === ApplicationShopInventoryFetchStatus.running;
}

@Injectable()
export class ApplicationShopInventoryService implements OnModuleInit {
  private readonly logger = new Logger(ApplicationShopInventoryService.name);
  private processing = false;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly coordinator: DidiStoreBindingCoordinator,
  ) {
    this.encryptionKey = this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
  }

  async onModuleInit() {
    await this.recoverStaleFetches();
  }

  private async recoverStaleFetches() {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const recovered = await this.prisma.applicationShopInventory.updateMany({
      where: {
        fetchStatus: ApplicationShopInventoryFetchStatus.running,
        updatedAt: { lt: staleBefore },
      },
      data: {
        fetchStatus: ApplicationShopInventoryFetchStatus.queued,
        fetchStartedAt: null,
        lastError: 'La consulta se reanudó porque el worker anterior dejó de reportar progreso.',
      },
    });
    if (recovered.count) {
      this.logger.warn(`Recovered ${recovered.count} interrupted application shop inventory fetch(es)`);
    }
  }

  async applicationOptions(q?: string) {
    const query = q?.trim();
    return this.prisma.application.findMany({
      where: {
        deletedAt: null,
        ...(query ? {
          OR: [
            { appName: { contains: query, mode: 'insensitive' } },
            { appId: { contains: query, mode: 'insensitive' } },
          ],
        } : {}),
      },
      select: {
        id: true,
        appId: true,
        appName: true,
        country: true,
        shopInventory: { select: { id: true } },
      },
      orderBy: [{ appName: 'asc' }, { appId: 'asc' }],
      take: 100,
    });
  }

  list() {
    return this.prisma.applicationShopInventory.findMany({
      include: INVENTORY_INCLUDE,
      orderBy: { application: { appName: 'asc' } },
    });
  }

  async add(applicationId: string, actorId: string) {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, deletedAt: null },
      select: { id: true, appId: true, appName: true, country: true },
    });
    if (!application) throw new NotFoundException('Application not found');
    try {
      return await this.prisma.$transaction(async tx => {
        const created = await tx.applicationShopInventory.create({
          data: { applicationId, createdById: actorId },
          include: INVENTORY_INCLUDE,
        });
        await tx.accessControlAudit.create({
          data: {
            actorId,
            scopeType: 'application_shop_inventory',
            scopeKey: created.id,
            before: safeAuditValue({ monitored: false }),
            after: safeAuditValue({
              action: 'added',
              monitored: true,
              applicationId: application.id,
              appId: application.appId,
              appName: application.appName,
            }),
          },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Application is already in the shop inventory section');
      }
      throw error;
    }
  }

  async remove(id: string, actorId: string) {
    const current = await this.requireInventory(id);
    if (fetchIsActive(current.fetchStatus)) {
      throw new ConflictException('The application cannot be removed while a fetch is queued or running');
    }
    await this.prisma.$transaction(async tx => {
      const removed = await tx.applicationShopInventory.deleteMany({
        where: {
          id,
          fetchStatus: { notIn: [
            ApplicationShopInventoryFetchStatus.queued,
            ApplicationShopInventoryFetchStatus.running,
          ] },
        },
      });
      if (removed.count !== 1) {
        throw new ConflictException('The application started a fetch and can no longer be removed');
      }
      await tx.accessControlAudit.create({
        data: {
          actorId,
          scopeType: 'application_shop_inventory',
          scopeKey: id,
          before: safeAuditValue({
            monitored: true,
            applicationId: current.applicationId,
            appId: current.application.appId,
            totalShops: current.totalShops,
            totalBrands: current.totalBrands,
          }),
          after: safeAuditValue({ action: 'removed', monitored: false }),
        },
      });
    });
    return { deleted: true };
  }

  async requestFetch(id: string, actorId: string) {
    const current = await this.requireInventory(id);
    if (current.application.deletedAt) {
      throw new ConflictException('The Application was removed and its credentials cannot be used');
    }
    if (fetchIsActive(current.fetchStatus)) {
      throw new ConflictException('A full shop inventory fetch is already queued or running');
    }
    const runId = randomUUID();
    const requestedAt = new Date();
    const updated = await this.prisma.$transaction(async tx => {
      const claimed = await tx.applicationShopInventory.updateMany({
        where: {
          id,
          fetchStatus: { notIn: [
            ApplicationShopInventoryFetchStatus.queued,
            ApplicationShopInventoryFetchStatus.running,
          ] },
        },
        data: {
          fetchStatus: ApplicationShopInventoryFetchStatus.queued,
          activeRunId: runId,
          fetchRequestedAt: requestedAt,
          fetchStartedAt: null,
          fetchFinishedAt: null,
          fetchPagesProcessed: 0,
          fetchShopsDiscovered: 0,
          fetchExpectedShops: null,
          lastRequestedById: actorId,
          lastError: null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('A full shop inventory fetch is already queued or running');
      await tx.accessControlAudit.create({
        data: {
          actorId,
          scopeType: 'application_shop_inventory',
          scopeKey: id,
          before: safeAuditValue({ fetchStatus: current.fetchStatus, activeRunId: current.activeRunId }),
          after: safeAuditValue({ action: 'fetch_requested', fetchStatus: 'queued', runId, requestedAt: requestedAt.toISOString() }),
        },
      });
      return tx.applicationShopInventory.findUniqueOrThrow({ where: { id }, include: INVENTORY_INCLUDE });
    });
    return updated;
  }

  async brands(id: string) {
    const inventory = await this.requireInventory(id);
    const shops = await this.prisma.applicationShopInventoryShop.findMany({
      where: { inventoryId: id },
      select: { brandExternalId: true, brandName: true, brandSource: true },
    });
    const groups = new Map<string, {
      brandExternalId: string | null;
      brandName: string | null;
      brandSource: string | null;
      shopCount: number;
    }>();
    for (const shop of shops) {
      const key = shop.brandExternalId
        ? `id:${shop.brandExternalId}`
        : shop.brandName
          ? `name:${shop.brandName.toLocaleLowerCase()}`
          : 'unknown';
      const group = groups.get(key) ?? { ...shop, shopCount: 0 };
      group.shopCount += 1;
      if (!group.brandName && shop.brandName) group.brandName = shop.brandName;
      if (group.brandSource !== shop.brandSource) group.brandSource = group.brandSource ?? shop.brandSource;
      groups.set(key, group);
    }
    return {
      inventoryId: id,
      totalShops: inventory.totalShops,
      identifiedBrandShops: inventory.identifiedBrandShops,
      data: [...groups.values()].sort((left, right) => right.shopCount - left.shopCount
        || (left.brandName ?? '').localeCompare(right.brandName ?? '')),
    };
  }

  async shops(id: string, params: { page: number; limit: number; q?: string; brand?: string }) {
    await this.requireInventory(id);
    const page = Math.max(1, params.page);
    const limit = Math.min(200, Math.max(1, params.limit));
    const query = params.q?.trim();
    const brand = params.brand?.trim();
    const filters: Prisma.ApplicationShopInventoryShopWhereInput[] = [];
    if (query) {
      filters.push({
        OR: [
          { shopName: { contains: query, mode: 'insensitive' } },
          { shopId: { contains: query, mode: 'insensitive' } },
          { appShopId: { contains: query, mode: 'insensitive' } },
          { brandName: { contains: query, mode: 'insensitive' } },
          { brandExternalId: { contains: query, mode: 'insensitive' } },
          { city: { contains: query, mode: 'insensitive' } },
        ],
      });
    }
    if (brand === '__unknown__') {
      filters.push({ brandExternalId: null, brandName: null });
    } else if (brand) {
      filters.push({
        OR: [
            { brandExternalId: brand },
            { brandName: { equals: brand, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.ApplicationShopInventoryShopWhereInput = {
      inventoryId: id,
      ...(filters.length ? { AND: filters } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.applicationShopInventoryShop.findMany({
        where,
        orderBy: [{ brandName: 'asc' }, { shopName: 'asc' }, { shopId: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.applicationShopInventoryShop.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  @Cron('*/10 * * * * *')
  async processQueuedFetch() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.recoverStaleFetches();
      const next = await this.prisma.applicationShopInventory.findFirst({
        where: { fetchStatus: ApplicationShopInventoryFetchStatus.queued },
        orderBy: [{ fetchRequestedAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, activeRunId: true },
      });
      if (!next?.activeRunId) return;
      const startedAt = new Date();
      const claimed = await this.prisma.applicationShopInventory.updateMany({
        where: {
          id: next.id,
          activeRunId: next.activeRunId,
          fetchStatus: ApplicationShopInventoryFetchStatus.queued,
        },
        data: {
          fetchStatus: ApplicationShopInventoryFetchStatus.running,
          fetchStartedAt: startedAt,
          lastError: null,
        },
      });
      if (claimed.count !== 1) return;
      await this.executeFetch(next.id, next.activeRunId);
    } finally {
      this.processing = false;
    }
  }

  private async executeFetch(inventoryId: string, runId: string) {
    let secret: string | undefined;
    try {
      const inventory = await this.prisma.applicationShopInventory.findUnique({
        where: { id: inventoryId },
        include: { application: true },
      });
      if (!inventory || inventory.activeRunId !== runId
        || inventory.fetchStatus !== ApplicationShopInventoryFetchStatus.running) return;
      if (inventory.application.deletedAt) {
        throw new ConflictException('The Application was removed before the inventory fetch started');
      }
      secret = decrypt(inventory.application.appSecret, this.encryptionKey);
      const remote = await this.fetchAllRemoteShops(
        inventoryId,
        runId,
        inventory.application.id,
        inventory.application.appId,
        secret,
      );
      const shops = await this.enrichFromLocalCatalog(inventory.application.id, remote);
      const fetchedAt = new Date();
      const identifiedBrandShops = shops.filter(shop => shop.brandExternalId || shop.brandName).length;
      const brandKeys = new Set(shops.flatMap(shop => {
        if (shop.brandExternalId) return [`id:${shop.brandExternalId}`];
        if (shop.brandName) return [`name:${shop.brandName.toLocaleLowerCase()}`];
        return [];
      }));
      await this.prisma.$transaction(async tx => {
        const current = await tx.applicationShopInventory.findUnique({
          where: { id: inventoryId },
          select: { activeRunId: true, fetchStatus: true },
        });
        if (current?.activeRunId !== runId
          || current.fetchStatus !== ApplicationShopInventoryFetchStatus.running) {
          throw new ConflictException('The inventory fetch lease was lost before publication');
        }
        await tx.applicationShopInventoryShop.deleteMany({ where: { inventoryId } });
        for (let offset = 0; offset < shops.length; offset += CREATE_CHUNK_SIZE) {
          const chunk = shops.slice(offset, offset + CREATE_CHUNK_SIZE);
          await tx.applicationShopInventoryShop.createMany({
            data: chunk.map(shop => ({
              inventoryId,
              shopId: shop.shopId,
              appShopId: shop.appShopId,
              shopName: shop.shopName,
              brandExternalId: shop.brandExternalId,
              brandName: shop.brandName,
              brandSource: shop.brandSource,
              city: shop.city,
              address: shop.address,
              fetchedAt,
            })),
          });
        }
        const published = await tx.applicationShopInventory.updateMany({
          where: {
            id: inventoryId,
            activeRunId: runId,
            fetchStatus: ApplicationShopInventoryFetchStatus.running,
          },
          data: {
            fetchStatus: ApplicationShopInventoryFetchStatus.succeeded,
            activeRunId: null,
            fetchFinishedAt: fetchedAt,
            lastSuccessfulFetchAt: fetchedAt,
            totalShops: shops.length,
            identifiedBrandShops,
            totalBrands: brandKeys.size,
            lastError: null,
          },
        });
        if (published.count !== 1) throw new ConflictException('The inventory fetch lease was lost during publication');
      }, { timeout: 120_000 });
      this.logger.log(`Published ${shops.length} shops for application inventory ${inventoryId}`);
    } catch (error) {
      const message = redactSensitiveText(
        error instanceof Error ? error.message : error,
        secret ? [secret] : [],
      ).slice(0, 1_000);
      await this.prisma.applicationShopInventory.updateMany({
        where: {
          id: inventoryId,
          activeRunId: runId,
          fetchStatus: ApplicationShopInventoryFetchStatus.running,
        },
        data: {
          fetchStatus: ApplicationShopInventoryFetchStatus.failed,
          activeRunId: null,
          fetchFinishedAt: new Date(),
          lastError: message,
        },
      });
      this.logger.error(`Application shop inventory ${inventoryId} failed: ${message}`);
    }
  }

  private async fetchAllRemoteShops(
    inventoryId: string,
    runId: string,
    applicationId: string,
    appId: string,
    appSecret: string,
  ): Promise<RemoteInventoryShop[]> {
    const byShopId = new Map<string, RemoteInventoryShop>();
    const appShopIds = new Map<string, string>();
    let expectedTotal: number | null = null;
    let pageNo = 1;
    while (pageNo <= MAX_PAGES) {
      await this.assertApplicationActive(applicationId);
      let responseStatus = 0;
      let responseOk = false;
      let responseErrno: number | null = null;
      let body: JsonRecord = {};
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const request = buildListBoundStoresRequest(appId, appSecret, pageNo, PAGE_SIZE);
        const response = await this.coordinator.withShopListRateLimit(applicationId, () => fetchWithEndpointContext(
          DIDI_LIST_BOUND_STORES_ENDPOINT,
          `${DIDI_BASE}${DIDI_LIST_BOUND_STORES_PATH}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: request.body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        ));
        responseStatus = response.status;
        responseOk = response.ok;
        body = parseJsonKeepingIds(await response.text()) as JsonRecord;
        responseErrno = parseProviderErrno(body.errno);
        if (responseErrno !== 10005 || attempt === 3) break;
      }
      if (!responseOk || responseErrno !== 0) {
        throw new Error(
          `${DIDI_LIST_BOUND_STORES_ENDPOINT} failed on page ${pageNo}: `
          + `${redactSensitiveText(body.errmsg || `HTTP ${responseStatus}`, [appSecret])} `
          + `(errno=${responseErrno ?? 'invalid'})`,
        );
      }
      const data = record(body.data);
      if (!data) throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned no data object`);
      const rawShops = Array.isArray(data.shops)
        ? data.shops
        : Array.isArray(data.shop_list)
          ? data.shop_list
          : null;
      if (!rawShops) throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned no shop list`);
      const rawTotal = parseNonNegativeCount(data.total_cnt ?? data.total);
      if (rawTotal === null) throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned an invalid total`);
      if (expectedTotal === null) expectedTotal = rawTotal;
      else if (expectedTotal !== rawTotal) {
        throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} total changed during pagination; retry the fetch`);
      }
      for (const rawShop of rawShops) {
        const shop = normalizeRemoteInventoryShop(rawShop);
        if (!shop) throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned a shop without shop_id or app_shop_id`);
        const previous = byShopId.get(shop.shopId);
        if (previous && previous.appShopId !== shop.appShopId) {
          throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned conflicting app_shop_id values for one shop_id`);
        }
        const previousShopId = appShopIds.get(shop.appShopId);
        if (previousShopId && previousShopId !== shop.shopId) {
          throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} returned one app_shop_id for multiple shop_id values`);
        }
        byShopId.set(shop.shopId, previous ? {
          ...previous,
          shopName: shop.shopName ?? previous.shopName,
          brandExternalId: shop.brandExternalId ?? previous.brandExternalId,
          brandName: shop.brandName ?? previous.brandName,
          city: shop.city ?? previous.city,
          address: shop.address ?? previous.address,
        } : shop);
        appShopIds.set(shop.appShopId, shop.shopId);
      }
      const progress = await this.prisma.applicationShopInventory.updateMany({
        where: {
          id: inventoryId,
          activeRunId: runId,
          fetchStatus: ApplicationShopInventoryFetchStatus.running,
        },
        data: {
          fetchPagesProcessed: pageNo,
          fetchShopsDiscovered: byShopId.size,
          fetchExpectedShops: expectedTotal,
        },
      });
      if (progress.count !== 1) throw new ConflictException('The inventory fetch lease was lost');
      const totalPages = Number(data.total_page ?? Math.max(1, Math.ceil((expectedTotal ?? 0) / PAGE_SIZE)));
      if (byShopId.size >= (expectedTotal ?? 0)
        || rawShops.length < PAGE_SIZE
        || (Number.isSafeInteger(totalPages) && pageNo >= totalPages)) break;
      pageNo += 1;
    }
    if (pageNo > MAX_PAGES) throw new Error(`${DIDI_LIST_BOUND_STORES_ENDPOINT} exceeded ${MAX_PAGES} pages`);
    if (expectedTotal === null || byShopId.size !== expectedTotal) {
      throw new Error(
        `${DIDI_LIST_BOUND_STORES_ENDPOINT} returned ${byShopId.size} unique shops but reported ${expectedTotal ?? 'unknown'}`,
      );
    }
    return [...byShopId.values()];
  }

  private async enrichFromLocalCatalog(
    applicationId: string,
    remote: RemoteInventoryShop[],
  ): Promise<StoredInventoryShop[]> {
    const brands = await this.prisma.brand.findMany({
      where: { applicationId, deletedAt: null },
      select: { id: true, brandId: true, brandName: true },
    });
    const brandsByExternalId = new Map(brands.map(brand => [brand.brandId, brand]));
    const localShops = new Map<string, {
      appShopId: string;
      name: string | null;
      city: string | null;
      address: string | null;
      brand: { brandId: string; brandName: string };
    }>();
    for (let offset = 0; offset < remote.length; offset += 500) {
      const chunk = remote.slice(offset, offset + 500).map(shop => shop.shopId);
      const matches = await this.prisma.shop.findMany({
        where: {
          shopId: { in: chunk },
          deletedAt: null,
          brand: { applicationId, deletedAt: null },
        },
        select: {
          shopId: true,
          appShopId: true,
          name: true,
          city: true,
          address: true,
          brand: { select: { brandId: true, brandName: true } },
        },
      });
      matches.forEach(shop => localShops.set(shop.shopId, shop));
    }
    return remote.map(shop => {
      const local = localShops.get(shop.shopId);
      const localBrandForRemote = shop.brandExternalId
        ? brandsByExternalId.get(shop.brandExternalId)
        : undefined;
      const hasRemoteBrand = Boolean(shop.brandExternalId || shop.brandName);
      return {
        ...shop,
        shopName: shop.shopName ?? local?.name ?? null,
        brandExternalId: shop.brandExternalId ?? local?.brand.brandId ?? null,
        brandName: shop.brandName
          ?? localBrandForRemote?.brandName
          ?? local?.brand.brandName
          ?? null,
        brandSource: hasRemoteBrand ? 'remote' : local ? 'local' : null,
        city: shop.city ?? local?.city ?? null,
        address: shop.address ?? local?.address ?? null,
      };
    });
  }

  private async assertApplicationActive(applicationId: string) {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { deletedAt: true },
    });
    if (!application || application.deletedAt) {
      throw new ConflictException('The Application was removed during the inventory fetch');
    }
  }

  private async requireInventory(id: string) {
    const inventory = await this.prisma.applicationShopInventory.findUnique({
      where: { id },
      include: INVENTORY_INCLUDE,
    });
    if (!inventory) throw new NotFoundException('Application shop inventory not found');
    return inventory;
  }
}
