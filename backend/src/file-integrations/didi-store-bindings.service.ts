import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountRole, DidiBindingEnvironment, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import {
  BindDidiStoresDto,
  ListDidiBoundStoresDto,
  ListDidiLocalStoresDto,
  UnbindDidiStoresDto,
  CreateDidiStoreBindingExecutionDto,
} from './dto/didi-store-binding.dto';
import { DidiStoreBindingCoordinator } from './didi-store-binding-coordinator.service';
import {
  buildBindRequest,
  buildListBoundStoresRequest,
  DIDI_BIND_MAX_SHOPS,
  DIDI_MASS_MAX_SHOPS,
  DIDI_BIND_STORE_ENDPOINT,
  DIDI_BIND_STORE_PATH,
  DIDI_LIST_BOUND_STORES_ENDPOINT,
  DIDI_LIST_BOUND_STORES_PATH,
  DIDI_UNBIND_STORE_ENDPOINT,
  DIDI_UNBIND_MAX_SHOPS,
  DIDI_UNBIND_STORE_PATH,
  DidiBindingResult,
  DidiBindingShopInput,
  exactConfirmation,
  fingerprintAppId,
  fingerprintBindingBatch,
  isExplicitBindResponse,
  normalizeBindResults,
  redactSensitiveText,
  stringifyDidiJsonWithInt64,
  summarizeBindingResults,
} from './didi-store-bindings.util';

interface BindingApplication {
  id: string;
  appId: string;
  appName: string;
  country: string;
  encryptedSecret: string;
  environment: 'test' | 'production';
  nameSignalsTest: boolean;
}

interface ValidatedLocalMapping {
  shopId: string;
  appShopId: string;
}

export interface BoundShop {
  shopId: string;
  appShopId: string;
  shopName: string;
  name: string;
  bound: boolean;
}

interface BoundPage {
  pageNo: number;
  pageSize: number;
  totalPages: number;
  total: number;
  shops: BoundShop[];
}

interface CachedBoundPage {
  page: BoundPage;
  fetchedAt: number;
  expiresAt: number;
}

interface BoundPageSnapshot {
  page: BoundPage;
  fetchedAt: number;
  cacheStatus: 'hit' | 'miss' | 'shared';
}

@Injectable()
export class DidiStoreBindingsService {
  private readonly logger = new Logger(DidiStoreBindingsService.name);
  private readonly encryptionKey: string;
  private readonly writesEnabled: boolean;
  private readonly productionBindEnabled: boolean;
  private readonly productionUnbindEnabled: boolean;
  private readonly testAppIds: Set<string>;
  private readonly requestTimeoutMs: number;
  private readonly boundPageCacheTtlMs: number;
  private readonly boundPageCacheMaxEntries: number;
  private readonly providerThrottleRetryMs: number;
  private readonly coordinator: DidiStoreBindingCoordinator;
  private readonly boundPageCache = new Map<string, CachedBoundPage>();
  private readonly boundPageRequests = new Map<string, Promise<CachedBoundPage>>();
  private readonly boundPageCacheGenerations = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() coordinator?: DidiStoreBindingCoordinator,
  ) {
    // Unit tests historically constructed this service directly. Production
    // always injects the shared coordinator from FileIntegrationsModule.
    this.coordinator = coordinator ?? new DidiStoreBindingCoordinator({
      // Direct construction is used only by isolated legacy unit tests. It
      // retains serialization/rate semantics without adding 20 seconds to
      // every mocked provider call; Nest production injects the real shared
      // coordinator with the provider-required 20 second minimum.
      get: (key: string, defaultValue: string) => key === 'DIDI_STORE_BINDINGS_SHOP_LIST_COOLDOWN_MS'
        ? '1'
        : config.get(key, defaultValue),
    } as ConfigService);
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.writesEnabled = config.get('DIDI_STORE_BINDINGS_ENABLED', 'true') === 'true';
    // Code defaults stay fail-closed. docker-compose.prod.yml explicitly
    // enables both production actions for registered Applications.
    this.productionBindEnabled = config.get('DIDI_STORE_BINDINGS_PRODUCTION_BIND_ENABLED', 'false') === 'true';
    this.productionUnbindEnabled = config.get('DIDI_STORE_BINDINGS_PRODUCTION_UNBIND_ENABLED', 'false') === 'true';
    this.testAppIds = new Set(
      String(config.get('DIDI_STORE_BINDINGS_TEST_APP_IDS', '5764607654490537991'))
        .split(',').map((value: string) => value.trim()).filter(Boolean),
    );
    const configuredTimeout = Number(config.get('DIDI_STORE_BINDINGS_TIMEOUT_MS', '30000'));
    this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
      ? Math.min(configuredTimeout, 120_000)
      : 30_000;
    const configuredCacheTtl = Number(config.get('DIDI_STORE_BINDINGS_PAGE_CACHE_TTL_MS', '60000'));
    this.boundPageCacheTtlMs = Number.isFinite(configuredCacheTtl) && configuredCacheTtl >= 20_000
      ? Math.min(configuredCacheTtl, 300_000)
      : 60_000;
    const configuredCacheEntries = Number(config.get('DIDI_STORE_BINDINGS_PAGE_CACHE_MAX_ENTRIES', '250'));
    this.boundPageCacheMaxEntries = Number.isInteger(configuredCacheEntries) && configuredCacheEntries >= 10
      ? Math.min(configuredCacheEntries, 2_000)
      : 250;
    const configuredThrottleRetry = Number(config.get('DIDI_STORE_BINDINGS_PROVIDER_THROTTLE_RETRY_MS', '20000'));
    this.providerThrottleRetryMs = config instanceof ConfigService
      && Number.isFinite(configuredThrottleRetry)
      && configuredThrottleRetry >= 20_000
      ? Math.min(configuredThrottleRetry, 120_000)
      : config instanceof ConfigService ? 20_000 : 1;
  }

  async listBoundStores(
    dto: ListDidiBoundStoresDto,
    actorRoles: AccountRole[] = [],
    executePermissionAllowed = false,
  ) {
    const application = await this.application(dto.applicationId);
    const secret = decrypt(application.encryptedSecret, this.encryptionKey);
    const snapshot = await this.fetchBoundPageCached(application, secret, dto.pageNo, dto.pageSize);
    return {
      application: this.publicApplication(application),
      guards: this.guardStatus(application, actorRoles, executePermissionAllowed),
      confirmation: {
        bind: application.environment === 'production'
          ? `PRODUCCION VINCULAR N TIENDAS APP_ID ${application.appId} LOTE <12-HEX>`
          : 'VINCULAR N TIENDAS',
        unbind: application.environment === 'production'
          ? `PRODUCCION DESVINCULAR 1 TIENDAS APP_ID ${application.appId} SHOP_ID N`
          : 'DESVINCULAR N TIENDAS',
      },
      remoteSnapshot: {
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        cacheStatus: snapshot.cacheStatus,
      },
      ...snapshot.page,
    };
  }

  async listLocalStores(
    dto: ListDidiLocalStoresDto,
    actorRoles: AccountRole[] = [],
    executePermissionAllowed = false,
  ) {
    const application = await this.application(dto.applicationId);
    const query = dto.q?.trim();
    const where: Prisma.ShopWhereInput = {
      deletedAt: null,
      brand: {
        is: {
          applicationId: application.id,
          deletedAt: null,
        },
      },
      ...(query ? {
        OR: [
          { shopId: { contains: query, mode: 'insensitive' } },
          { appShopId: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
          { city: { contains: query, mode: 'insensitive' } },
          { brand: { is: { brandName: { contains: query, mode: 'insensitive' } } } },
        ],
      } : {}),
    };
    const skip = (dto.pageNo - 1) * dto.pageSize;
    const [localShops, total] = await Promise.all([
      this.prisma.shop.findMany({
        where,
        select: {
          shopId: true,
          appShopId: true,
          name: true,
          city: true,
          brand: { select: { id: true, brandName: true } },
        },
        orderBy: [{ shopId: 'asc' }],
        skip,
        take: dto.pageSize,
      }),
      this.prisma.shop.count({ where }),
    ]);
    const visibleAppShopIds = [...new Set(localShops.map(shop => shop.appShopId))];
    const visibleMappings = visibleAppShopIds.length
      ? await this.prisma.shop.findMany({
        where: {
          deletedAt: null,
          appShopId: { in: visibleAppShopIds },
          brand: { is: { applicationId: application.id, deletedAt: null } },
        },
        select: { shopId: true, appShopId: true },
      })
      : [];
    const shopIdsByAppShopId = new Map<string, Set<string>>();
    for (const mapping of visibleMappings) {
      const shopIds = shopIdsByAppShopId.get(mapping.appShopId) ?? new Set<string>();
      shopIds.add(mapping.shopId);
      shopIdsByAppShopId.set(mapping.appShopId, shopIds);
    }
    return {
      source: 'local' as const,
      application: this.publicApplication(application),
      guards: this.guardStatus(application, actorRoles, executePermissionAllowed),
      pageNo: dto.pageNo,
      pageSize: dto.pageSize,
      totalPages: Math.max(1, Math.ceil(total / dto.pageSize)),
      total,
      shops: localShops.map(shop => ({
        shopId: shop.shopId,
        appShopId: shop.appShopId,
        name: shop.name ?? '',
        city: shop.city ?? '',
        brandId: shop.brand.id,
        brandName: shop.brand.brandName,
        mappingConflict: (shopIdsByAppShopId.get(shop.appShopId)?.size ?? 0) > 1,
      })),
    };
  }

  async selectLocalStores(
    applicationId: string,
    q: string | undefined,
    actorRoles: AccountRole[] = [],
    executePermissionAllowed = false,
  ) {
    const application = await this.application(applicationId);
    const query = q?.trim();
    const where: Prisma.ShopWhereInput = {
      deletedAt: null,
      brand: { is: { applicationId: application.id, deletedAt: null } },
      ...(query ? {
        OR: [
          { shopId: { contains: query, mode: 'insensitive' } },
          { appShopId: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
          { city: { contains: query, mode: 'insensitive' } },
          { brand: { is: { brandName: { contains: query, mode: 'insensitive' } } } },
        ],
      } : {}),
    };
    const [shops, total] = await Promise.all([
      this.prisma.shop.findMany({
        where,
        select: {
          shopId: true,
          appShopId: true,
          name: true,
          city: true,
          brand: { select: { id: true, brandName: true } },
        },
        orderBy: [{ shopId: 'asc' }],
        take: DIDI_MASS_MAX_SHOPS + 1,
      }),
      this.prisma.shop.count({ where }),
    ]);
    const selected = shops.slice(0, DIDI_MASS_MAX_SHOPS);
    const appShopIds = [...new Set(selected.map(shop => shop.appShopId))];
    const mappings = appShopIds.length ? await this.prisma.shop.findMany({
      where: {
        deletedAt: null,
        appShopId: { in: appShopIds },
        brand: { is: { applicationId: application.id, deletedAt: null } },
      },
      select: { shopId: true, appShopId: true },
    }) : [];
    const idsByAppShopId = new Map<string, Set<string>>();
    for (const mapping of mappings) {
      const ids = idsByAppShopId.get(mapping.appShopId) ?? new Set<string>();
      ids.add(mapping.shopId);
      idsByAppShopId.set(mapping.appShopId, ids);
    }
    const rows = selected.map(shop => ({
      shopId: shop.shopId,
      appShopId: shop.appShopId,
      name: shop.name ?? '',
      city: shop.city ?? '',
      brandId: shop.brand.id,
      brandName: shop.brand.brandName,
      mappingConflict: (idsByAppShopId.get(shop.appShopId)?.size ?? 0) > 1,
    }));
    return {
      application: this.publicApplication(application),
      guards: this.guardStatus(application, actorRoles, executePermissionAllowed),
      total,
      max: DIDI_MASS_MAX_SHOPS,
      truncated: total > DIDI_MASS_MAX_SHOPS,
      conflicts: rows.filter(shop => shop.mappingConflict).length,
      shops: rows,
    };
  }

  async prepareMassExecution(dto: CreateDidiStoreBindingExecutionDto, actorRoles: AccountRole[]) {
    this.assertUnique(dto.shops, true, DIDI_MASS_MAX_SHOPS);
    if (dto.action === 'bind' && dto.shops.some(shop => shop.remotePageNo !== undefined)) {
      throw new BadRequestException('remotePageNo is only allowed for Unbind');
    }
    if (dto.action === 'unbind' && dto.shops.some(shop => !shop.remotePageNo)) {
      throw new BadRequestException('Every Unbind store requires remotePageNo from the DiDi shop-list page');
    }
    const application = await this.application(dto.applicationId);
    this.assertWriteAllowed(
      application,
      dto.confirmation,
      dto.action,
      dto.shops,
      dto.reason,
      dto.productionAcknowledged,
      actorRoles,
    );
    await this.assertLocalMappings(application, dto.shops);
    return {
      application: this.publicApplication(application),
      environment: application.environment,
      batchFingerprint: fingerprintBindingBatch(dto.shops),
      applicationSnapshotFingerprint: createHash('sha256')
        .update(`${application.appId}\u0000${application.encryptedSecret}`)
        .digest('hex'),
    };
  }

  async assertDurableRuntimeAllowed(
    applicationId: string,
    action: 'bind' | 'unbind',
    expectedEnvironment: 'test' | 'production',
    expectedApplicationSnapshotFingerprint?: string,
  ) {
    const application = await this.application(applicationId);
    if (application.environment !== expectedEnvironment) {
      throw new ConflictException('Application binding environment changed after this execution was queued');
    }
    const currentSnapshotFingerprint = createHash('sha256')
      .update(`${application.appId}\u0000${application.encryptedSecret}`)
      .digest('hex');
    if (expectedApplicationSnapshotFingerprint
      && currentSnapshotFingerprint !== expectedApplicationSnapshotFingerprint) {
      throw new ConflictException('Application app_id or credential changed after this execution was queued');
    }
    if (!this.writesEnabled) {
      throw new ForbiddenException('DiDi store binding writes are disabled by DIDI_STORE_BINDINGS_ENABLED');
    }
    if (application.environment === 'production') {
      const enabled = action === 'bind' ? this.productionBindEnabled : this.productionUnbindEnabled;
      if (!enabled) {
        throw new ForbiddenException(
          `Production DiDi ${action} is disabled by DIDI_STORE_BINDINGS_PRODUCTION_${action.toUpperCase()}_ENABLED`,
        );
      }
    }
    return application;
  }

  withDurableOperationLock<T>(applicationId: string, operation: () => Promise<T>) {
    return this.withApplicationLock(applicationId, operation);
  }

  async executeDurableBindBatch(
    applicationId: string,
    shops: Array<{ shopId: string; appShopId: string }>,
    expectedEnvironment: 'test' | 'production',
    expectedApplicationSnapshotFingerprint?: string,
    beforeSubmit?: () => Promise<void>,
  ): Promise<DidiBindingResult[]> {
    const application = await this.assertDurableRuntimeAllowed(
      applicationId,
      'bind',
      expectedEnvironment,
      expectedApplicationSnapshotFingerprint,
    );
    await this.assertLocalMappings(application, shops);
    let secret = '';
    let postStarted = false;
    let explicitDecisionReceived = false;
    try {
      secret = decrypt(application.encryptedSecret, this.encryptionKey);
      let submissionBoundaryPersisted = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (attempt > 1) {
          const retryApplication = await this.assertDurableRuntimeAllowed(
            applicationId,
            'bind',
            expectedEnvironment,
            expectedApplicationSnapshotFingerprint,
          );
          await this.assertLocalMappings(retryApplication, shops);
        }
        const request = buildBindRequest(application.appId, secret, shops);
        if (!submissionBoundaryPersisted && beforeSubmit) {
          await beforeSubmit();
          submissionBoundaryPersisted = true;
        }
        postStarted = true;
        explicitDecisionReceived = false;
        const response = await fetchWithEndpointContext(
          DIDI_BIND_STORE_ENDPOINT,
          `${DIDI_BASE}${DIDI_BIND_STORE_PATH}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: request.body,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          },
        );
        const body = parseJsonKeepingIds(await response.text());
        const explicitProviderFailure = this.hasExplicitProviderErrno(body);
        if (explicitProviderFailure) explicitDecisionReceived = true;
        const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (Number(bodyRecord.errno) === 10005 && attempt < 3) {
          await sleep(this.providerThrottleRetryMs);
          continue;
        }
        if (!response.ok) {
          if (explicitProviderFailure) return normalizeBindResults(shops, body);
          throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
        }
        if (!isExplicitBindResponse(body)) {
          throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned no explicit result (HTTP ${response.status})`);
        }
        explicitDecisionReceived = true;
        return normalizeBindResults(shops, body);
      }
      throw new Error(`${DIDI_BIND_STORE_ENDPOINT} exhausted explicit throttle retries`);
    } catch (error) {
      const message = redactSensitiveText((error as Error).message, secret ? [secret] : []);
      const unconfirmed = postStarted && !explicitDecisionReceived;
      return shops.map(shop => ({
        ...shop,
        status: unconfirmed ? 'unconfirmed' : 'failed',
        reason: unconfirmed ? `${message}. Verifica estado antes de reintentar.` : message,
      }));
    } finally {
      this.invalidateBoundPageCache(application.id);
    }
  }

  async verifyDurableUnbindPage(
    applicationId: string,
    shops: Array<{ shopId: string; appShopId: string }>,
    pageNo: number,
    expectedEnvironment: 'test' | 'production',
    expectedApplicationSnapshotFingerprint?: string,
  ) {
    const application = await this.assertDurableRuntimeAllowed(
      applicationId,
      'unbind',
      expectedEnvironment,
      expectedApplicationSnapshotFingerprint,
    );
    const localMappings = await this.assertLocalMappings(application, shops);
    const targets = application.environment === 'production' ? localMappings : shops;
    const secret = decrypt(application.encryptedSecret, this.encryptionKey);
    return this.verifyBoundMappingsOnPage(application, secret, targets, pageNo);
  }

  async executeDurableUnbindItem(
    applicationId: string,
    shop: { shopId: string; appShopId: string },
    expectedEnvironment: 'test' | 'production',
    expectedApplicationSnapshotFingerprint?: string,
    beforeSubmit?: () => Promise<void>,
  ): Promise<DidiBindingResult> {
    const application = await this.assertDurableRuntimeAllowed(
      applicationId,
      'unbind',
      expectedEnvironment,
      expectedApplicationSnapshotFingerprint,
    );
    // Re-check each local mapping immediately before the token/submission
    // boundary. A Brand or Application assignment can change while the other
    // stores from the freshly verified remote page are being processed.
    await this.assertLocalMappings(application, [shop]);
    let secret = '';
    let token = '';
    let postStarted = false;
    let explicitDecisionReceived = false;
    try {
      secret = decrypt(application.encryptedSecret, this.encryptionKey);
      token = await getAuthToken(
        application.appId,
        secret,
        shop.appShopId,
        AbortSignal.timeout(this.requestTimeoutMs),
      );
      if (typeof token !== 'string' || !token.trim()) throw new Error('DiDi auth completed without an auth_token');
      const submissionApplication = await this.assertDurableRuntimeAllowed(
        applicationId,
        'unbind',
        expectedEnvironment,
        expectedApplicationSnapshotFingerprint,
      );
      await this.assertLocalMappings(submissionApplication, [shop]);
      if (beforeSubmit) await beforeSubmit();
      postStarted = true;
      const response = await fetchWithEndpointContext(
        DIDI_UNBIND_STORE_ENDPOINT,
        `${DIDI_BASE}${DIDI_UNBIND_STORE_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_token: token }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      const parsed = parseJsonKeepingIds(await response.text());
      const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
      const rawErrno = body?.errno;
      const errno = typeof rawErrno === 'number' && Number.isFinite(rawErrno)
        ? rawErrno
        : typeof rawErrno === 'string' && /^-?\d+$/.test(rawErrno)
          ? Number(rawErrno)
          : Number.NaN;
      if (!Number.isFinite(errno)) {
        throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned no explicit errno (HTTP ${response.status})`);
      }
      if (errno !== 0) {
        explicitDecisionReceived = true;
        throw new Error(
          `${DIDI_UNBIND_STORE_ENDPOINT} failed: ${redactSensitiveText(body?.errmsg || `HTTP ${response.status}`, [token])}`
          + ` (errno=${errno})`,
        );
      }
      if (!response.ok) throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
      if (body?.data !== true) throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned errno=0 without data=true`);
      explicitDecisionReceived = true;
      return { ...shop, status: 'success', submissionStarted: true };
    } catch (error) {
      const unconfirmed = postStarted && !explicitDecisionReceived;
      const message = redactSensitiveText((error as Error).message, [token, secret].filter(Boolean));
      return {
        ...shop,
        status: unconfirmed ? 'unconfirmed' : 'failed',
        reason: unconfirmed ? `${message}. Verifica estado antes de reintentar.` : message,
        submissionStarted: postStarted,
      };
    } finally {
      this.invalidateBoundPageCache(application.id);
    }
  }

  async bind(dto: BindDidiStoresDto, actorId: string, actorRoles: AccountRole[]) {
    this.assertUnique(dto.shops, true, DIDI_BIND_MAX_SHOPS);
    const application = await this.application(dto.applicationId);
    this.assertWriteAllowed(
      application,
      dto.confirmation,
      'bind',
      dto.shops,
      dto.reason,
      dto.productionAcknowledged,
      actorRoles,
    );
    return this.withApplicationLock(application.id, async () => {
      await this.assertNoDurableExecution(application.id);
      await this.assertLocalMappings(application, dto.shops);
      return this.bindLocked(dto, actorId, application);
    });
  }

  private async bindLocked(dto: BindDidiStoresDto, actorId: string, application: BindingApplication) {
    const operationId = randomUUID();
    const audit = await this.startAudit(operationId, actorId, application, 'bind', dto.shops, dto.reason);
    const started = Date.now();
    let results: DidiBindingResult[];
    let secret = '';
    let postStarted = false;
    let explicitDecisionReceived = false;

    try {
      secret = decrypt(application.encryptedSecret, this.encryptionKey);
      const request = buildBindRequest(application.appId, secret, dto.shops);
      postStarted = true;
      const response = await fetchWithEndpointContext(
        DIDI_BIND_STORE_ENDPOINT,
        `${DIDI_BASE}${DIDI_BIND_STORE_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      const body = parseJsonKeepingIds(await response.text());
      const explicitProviderFailure = this.hasExplicitProviderErrno(body);
      if (explicitProviderFailure) explicitDecisionReceived = true;
      if (!response.ok) {
        if (explicitProviderFailure) {
          results = normalizeBindResults(dto.shops, body);
        } else {
          throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
        }
      } else {
        if (!isExplicitBindResponse(body)) {
          throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned no explicit result (HTTP ${response.status})`);
        }
        explicitDecisionReceived = true;
        results = normalizeBindResults(dto.shops, body);
      }
    } catch (error) {
      const message = redactSensitiveText((error as Error).message, secret ? [secret] : []);
      const unconfirmed = postStarted && !explicitDecisionReceived;
      results = dto.shops.map(shop => ({
        ...shop,
        status: unconfirmed ? 'unconfirmed' : 'failed',
        reason: unconfirmed ? `${message}. Verifica estado antes de reintentar.` : message,
      }));
    }

    this.invalidateBoundPageCache(application.id);
    return this.finish(operationId, audit.id, application, 'bind', results, Date.now() - started);
  }

  async unbind(dto: UnbindDidiStoresDto, actorId: string, actorRoles: AccountRole[]) {
    this.assertUnique(dto.shops, true, DIDI_UNBIND_MAX_SHOPS);
    const application = await this.application(dto.applicationId);
    this.assertWriteAllowed(
      application,
      dto.confirmation,
      'unbind',
      dto.shops,
      dto.reason,
      dto.productionAcknowledged,
      actorRoles,
    );
    if (!dto.remotePageNo) {
      throw new BadRequestException(
        'Unbind requires remotePageNo from the DiDi shop-list page where the store was selected',
      );
    }
    return this.withApplicationLock(
      application.id,
      async () => {
        await this.assertNoDurableExecution(application.id);
        const localMappings = await this.assertLocalMappings(application, dto.shops);
        return this.unbindLocked(dto, actorId, application, localMappings);
      },
    );
  }

  private async unbindLocked(
    dto: UnbindDidiStoresDto,
    actorId: string,
    application: BindingApplication,
    localMappings: ValidatedLocalMapping[],
  ) {
    const operationId = randomUUID();
    const audit = await this.startAudit(operationId, actorId, application, 'unbind', dto.shops, dto.reason);
    const started = Date.now();
    let results: DidiBindingResult[] = [];
    let secret = '';

    try {
      secret = decrypt(application.encryptedSecret, this.encryptionKey);
      // Unbind is anchored to a freshly re-fetched provider page chosen in the
      // UI. This keeps verification O(1) even for Applications with thousands
      // of shops and never trades away the exact production-local mapping.
      const verificationTargets = application.environment === 'production'
        ? localMappings
        : dto.shops.map(shop => ({ shopId: shop.shopId, appShopId: shop.appShopId }));
      const resolved = await this.verifyBoundMappingsOnPage(
        application,
        secret,
        verificationTargets,
        dto.remotePageNo,
      );
      results = resolved.failures;

      // Deliberately sequential: every store has its own refresh/get token flow,
      // and partial successes must remain attributable to one input row.
      for (const shop of resolved.shops) {
        let token = '';
        let postStarted = false;
        let explicitDecisionReceived = false;
        try {
          const authToken = await getAuthToken(
            application.appId,
            secret,
            shop.appShopId,
            AbortSignal.timeout(this.requestTimeoutMs),
          );
          if (typeof authToken !== 'string' || !authToken.trim()) {
            throw new Error('DiDi auth completed without an auth_token');
          }
          token = authToken;
          postStarted = true;
          const response = await fetchWithEndpointContext(
            DIDI_UNBIND_STORE_ENDPOINT,
            `${DIDI_BASE}${DIDI_UNBIND_STORE_PATH}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ auth_token: token }),
              signal: AbortSignal.timeout(this.requestTimeoutMs),
            },
          );
          const parsed = parseJsonKeepingIds(await response.text());
          const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
          const rawErrno = body?.errno;
          const errno = typeof rawErrno === 'number' && Number.isFinite(rawErrno)
            ? rawErrno
            : typeof rawErrno === 'string' && /^-?\d+$/.test(rawErrno)
              ? Number(rawErrno)
              : Number.NaN;
          if (!Number.isFinite(errno)) {
            throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned no explicit errno (HTTP ${response.status})`);
          }
          if (errno !== 0) {
            explicitDecisionReceived = true;
            throw new Error(
              `${DIDI_UNBIND_STORE_ENDPOINT} failed: ${redactSensitiveText(body?.errmsg || `HTTP ${response.status}`, [token])}`
              + ` (errno=${errno})`,
            );
          }
          if (!response.ok) {
            throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
          }
          if (body?.data !== true) {
            throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned errno=0 without data=true`);
          }
          explicitDecisionReceived = true;
          results.push({ ...shop, status: 'success' });
        } catch (error) {
          const unconfirmed = postStarted && !explicitDecisionReceived;
          const message = redactSensitiveText((error as Error).message, [token, secret].filter(Boolean));
          results.push({
            ...shop,
            status: unconfirmed ? 'unconfirmed' : 'failed',
            reason: unconfirmed ? `${message}. Verifica estado antes de reintentar.` : message,
          });
        }
      }
    } catch (error) {
      const message = redactSensitiveText((error as Error).message, secret ? [secret] : []);
      results = dto.shops.map(shop => ({ ...shop, status: 'failed', reason: message }));
    }

    const order = new Map(dto.shops.map((shop, index) => [shop.appShopId, index]));
    results.sort((left, right) => (order.get(left.appShopId) ?? 0) - (order.get(right.appShopId) ?? 0));
    this.invalidateBoundPageCache(application.id);
    return this.finish(operationId, audit.id, application, 'unbind', results, Date.now() - started);
  }

  private async withApplicationLock<T>(applicationId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.withLock(applicationId, operation);
  }

  private hasExplicitProviderErrno(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const raw = (body as Record<string, unknown>).errno;
    const errno = typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
    return Number.isFinite(errno) && errno !== 0;
  }

  private async assertNoDurableExecution(applicationId: string) {
    // The optional check only exists to keep legacy isolated unit-test doubles
    // compatible. PrismaService in the running application always has this
    // delegate after the additive migration.
    const delegate = (this.prisma as PrismaService & {
      didiStoreBindingExecution?: {
        findFirst(input: unknown): Promise<{ id: string } | null>;
      };
    }).didiStoreBindingExecution;
    if (!delegate) return;
    const active = await delegate.findFirst({
      where: { applicationId, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException('A massive DiDi bind/unbind execution is active for this application');
    }
  }

  private async application(id: string): Promise<BindingApplication> {
    const application = await this.prisma.application.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        appId: true,
        appName: true,
        country: true,
        appSecret: true,
        didiBindingEnvironment: true,
      },
    });
    if (!application) throw new NotFoundException('Application not found');
    if (typeof application.appId !== 'string' || !/^\d+$/.test(application.appId)) {
      throw new BadRequestException('Application app_id must be a decimal string');
    }
    const rawEnvironment = application.didiBindingEnvironment;
    if (rawEnvironment !== DidiBindingEnvironment.TEST
      && rawEnvironment !== DidiBindingEnvironment.PRODUCTION) {
      throw new BadRequestException('Application didiBindingEnvironment must be explicitly TEST or PRODUCTION');
    }
    const namedTest = /(?:^|[_\s-])(?:t|test|sandbox)(?:[_\s-]|$)/i.test(application.appName);
    const allowlisted = this.testAppIds.has(application.appId);
    const environment = rawEnvironment === DidiBindingEnvironment.TEST ? 'test' : 'production';
    if (environment === 'test' && !allowlisted) {
      throw new BadRequestException('Test application app_id is not in DIDI_STORE_BINDINGS_TEST_APP_IDS');
    }
    if (environment === 'production' && allowlisted) {
      throw new BadRequestException('Production application app_id is present in DIDI_STORE_BINDINGS_TEST_APP_IDS');
    }
    return {
      id: application.id,
      appId: application.appId,
      appName: application.appName,
      country: String(application.country),
      encryptedSecret: application.appSecret,
      environment,
      nameSignalsTest: namedTest,
    };
  }

  private publicApplication(application: BindingApplication) {
    return {
      id: application.id,
      appId: application.appId,
      appName: application.appName,
      country: application.country,
      environment: application.environment,
      nameSignalsTest: application.nameSignalsTest,
    };
  }

  private guardStatus(
    application: BindingApplication,
    actorRoles: AccountRole[],
    executePermissionAllowed: boolean,
  ) {
    const productionRoleAllowed = application.environment === 'test'
      || actorRoles.includes(AccountRole.super_admin);
    const canBind = this.writesEnabled
      && executePermissionAllowed
      && productionRoleAllowed
      && (application.environment === 'test' || this.productionBindEnabled);
    const canUnbind = this.writesEnabled
      && executePermissionAllowed
      && productionRoleAllowed
      && (application.environment === 'test' || this.productionUnbindEnabled);
    return {
      writesEnabled: this.writesEnabled,
      productionWritesEnabled: this.productionBindEnabled || this.productionUnbindEnabled,
      productionBindEnabled: this.productionBindEnabled,
      productionUnbindEnabled: this.productionUnbindEnabled,
      productionRoleAllowed,
      executePermissionAllowed,
      canBind,
      canUnbind,
      canWrite: canBind || canUnbind,
    };
  }

  private assertWriteAllowed(
    application: BindingApplication,
    confirmation: string,
    action: 'bind' | 'unbind',
    shops: DidiBindingShopInput[],
    reason?: string,
    productionAcknowledged?: boolean,
    actorRoles: AccountRole[] = [],
  ) {
    if (!this.writesEnabled) {
      throw new ForbiddenException('DiDi store binding writes are disabled by DIDI_STORE_BINDINGS_ENABLED');
    }
    if (application.environment === 'production') {
      if (!actorRoles.includes(AccountRole.super_admin)) {
        throw new ForbiddenException('Production DiDi Bind/Unbind requires the super_admin role');
      }
      const actionEnabled = action === 'bind' ? this.productionBindEnabled : this.productionUnbindEnabled;
      if (!actionEnabled) {
        throw new ForbiddenException(
          `Production DiDi ${action} is disabled by DIDI_STORE_BINDINGS_PRODUCTION_${action.toUpperCase()}_ENABLED`,
        );
      }
      if (!reason || reason.trim().length < 10) {
        throw new BadRequestException('A production reason or ticket of at least 10 characters is required');
      }
      if (productionAcknowledged !== true) {
        throw new BadRequestException('productionAcknowledged must be true for production writes');
      }
    }
    const expected = exactConfirmation(
      action,
      shops,
      application.environment,
      application.appId,
    );
    if (confirmation !== expected) {
      throw new BadRequestException(`Confirmation must exactly match: ${expected}`);
    }
  }

  private async assertLocalMappings(
    application: BindingApplication,
    shops: DidiBindingShopInput[],
  ): Promise<ValidatedLocalMapping[]> {
    const requestedByShopId = new Map(shops.filter(shop => shop.shopId).map(shop => [shop.shopId as string, shop]));
    if (!requestedByShopId.size) return [];
    const requestedAppShopIds = [...new Set(shops.map(shop => shop.appShopId))];
    const [localShops, activeAppShopMappings] = await Promise.all([
      this.prisma.shop.findMany({
        where: { shopId: { in: [...requestedByShopId.keys()] } },
        select: {
          shopId: true,
          appShopId: true,
          deletedAt: true,
          brand: { select: { applicationId: true, deletedAt: true } },
        },
      }),
      this.prisma.shop.findMany({
        where: {
          deletedAt: null,
          appShopId: { in: requestedAppShopIds },
          brand: { is: { applicationId: application.id, deletedAt: null } },
        },
        select: { shopId: true, appShopId: true },
      }),
    ]);
    const activeShopIdsByAppShopId = new Map<string, Set<string>>();
    for (const mapping of activeAppShopMappings) {
      const shopIds = activeShopIdsByAppShopId.get(mapping.appShopId) ?? new Set<string>();
      shopIds.add(mapping.shopId);
      activeShopIdsByAppShopId.set(mapping.appShopId, shopIds);
    }
    for (const requested of shops) {
      const mappedShopIds = new Set(activeShopIdsByAppShopId.get(requested.appShopId) ?? []);
      if (requested.shopId) mappedShopIds.add(requested.shopId);
      if (mappedShopIds.size > 1) {
        throw new BadRequestException(
          `appShopId ${requested.appShopId} maps to multiple active shopIds in this Application`,
        );
      }
    }
    const localByShopId = new Map<string, typeof localShops[number]>();
    for (const local of localShops) {
      if (localByShopId.has(local.shopId)) {
        throw new BadRequestException(`Duplicate local records found for shopId ${local.shopId}`);
      }
      localByShopId.set(local.shopId, local);
    }

    const validated: ValidatedLocalMapping[] = [];
    for (const requested of shops) {
      const shopId = requested.shopId as string;
      const local = localByShopId.get(shopId);
      if (!local) {
        if (application.environment === 'production') {
          throw new BadRequestException(`shopId ${shopId} has no local mapping for this production Application`);
        }
        continue;
      }
      if (local.deletedAt) {
        throw new BadRequestException(`shopId ${local.shopId} is soft-deleted locally and cannot be changed`);
      }
      if (local.brand.deletedAt) {
        throw new BadRequestException(`shopId ${local.shopId} belongs to a soft-deleted local Brand`);
      }
      if (application.environment === 'production' && local.brand.applicationId !== application.id) {
        throw new BadRequestException(
          local.brand.applicationId === null
            ? `shopId ${local.shopId} has no Application assigned locally`
            : `shopId ${local.shopId} belongs to another Application`,
        );
      }
      if (application.environment === 'test'
        && local.brand.applicationId
        && local.brand.applicationId !== application.id) {
        throw new BadRequestException(`shopId ${local.shopId} belongs to another Application`);
      }
      if (local.appShopId !== requested.appShopId) {
        throw new BadRequestException(
          `Mapping mismatch for shopId ${local.shopId}: local appShopId is ${local.appShopId}`,
        );
      }
      validated.push({ shopId: local.shopId, appShopId: local.appShopId });
    }
    return validated;
  }

  private assertUnique(shops: DidiBindingShopInput[], requireShopId: boolean, maxShops: number) {
    if (shops.length > maxShops) {
      throw new BadRequestException(maxShops === 1 ? 'At most 1 store is allowed' : `At most ${maxShops} stores are allowed`);
    }
    const appShopIds = new Set<string>();
    const shopIds = new Set<string>();
    for (const shop of shops) {
      if (!shop.appShopId || shop.appShopId !== shop.appShopId.trim()) {
        throw new BadRequestException('appShopId cannot be blank or contain leading/trailing whitespace');
      }
      if (appShopIds.has(shop.appShopId)) throw new BadRequestException(`Duplicate appShopId: ${shop.appShopId}`);
      appShopIds.add(shop.appShopId);
      if (requireShopId && !shop.shopId) throw new BadRequestException('shopId is required');
      if (shop.shopId) {
        if (shopIds.has(shop.shopId)) throw new BadRequestException(`Duplicate shopId: ${shop.shopId}`);
        shopIds.add(shop.shopId);
      }
    }
  }

  private async fetchBoundPage(
    application: BindingApplication,
    secret: string,
    pageNo: number,
    pageSize: number,
  ): Promise<BoundPage> {
    let body: Record<string, unknown> = {};
    let responseStatus = 0;
    let responseOk = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const request = buildListBoundStoresRequest(application.appId, secret, pageNo, pageSize);
      const response = await this.coordinator.withShopListRateLimit(application.id, () => fetchWithEndpointContext(
        DIDI_LIST_BOUND_STORES_ENDPOINT,
        `${DIDI_BASE}${DIDI_LIST_BOUND_STORES_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ));
      responseStatus = response.status;
      responseOk = response.ok;
      body = parseJsonKeepingIds(await response.text()) as Record<string, unknown>;
      if (Number(body.errno) !== 10005 || attempt === 3) break;
    }
    if (!responseOk || Number(body.errno) !== 0) {
      throw new Error(
        `${DIDI_LIST_BOUND_STORES_ENDPOINT} failed: ${redactSensitiveText(body.errmsg || `HTTP ${responseStatus}`, [secret])}`
        + ` (errno=${body.errno ?? 'unknown'})`,
      );
    }
    const data = body.data as Record<string, unknown> | undefined;
    const shops = Array.isArray(data?.shops) ? data.shops : Array.isArray(data?.shop_list) ? data.shop_list : [];
    const total = Number(data?.total_cnt ?? data?.total ?? shops.length);
    return {
      pageNo: Number(data?.page_no ?? pageNo),
      pageSize: Number(data?.page_size ?? pageSize),
      totalPages: Number(data?.total_page ?? Math.max(1, Math.ceil(total / pageSize))),
      total,
      shops: shops.flatMap((value: unknown) => {
        if (!value || typeof value !== 'object') return [];
        const shop = value as Record<string, unknown>;
        return [{
          shopId: String(shop.shop_id ?? ''),
          appShopId: String(shop.app_shop_id ?? ''),
          shopName: String(shop.shop_name ?? ''),
          name: String(shop.shop_name ?? ''),
          bound: shop.bound_flag === undefined ? true : Number(shop.bound_flag) === 1,
        }];
      }).filter(shop => shop.shopId && shop.appShopId),
    };
  }

  private async fetchBoundPageCached(
    application: BindingApplication,
    secret: string,
    pageNo: number,
    pageSize: number,
  ): Promise<BoundPageSnapshot> {
    const key = this.boundPageCacheKey(application.id, pageNo, pageSize);
    const generation = this.boundPageCacheGenerations.get(application.id) ?? 0;
    const requestKey = `${key}:${generation}`;
    const now = Date.now();
    const cached = this.boundPageCache.get(key);
    if (cached && cached.expiresAt > now) {
      // Refresh insertion order so pruning behaves as a small LRU.
      this.boundPageCache.delete(key);
      this.boundPageCache.set(key, cached);
      return { page: cached.page, fetchedAt: cached.fetchedAt, cacheStatus: 'hit' };
    }
    if (cached) this.boundPageCache.delete(key);

    const shared = this.boundPageRequests.get(requestKey);
    if (shared) {
      const entry = await shared;
      return { page: entry.page, fetchedAt: entry.fetchedAt, cacheStatus: 'shared' };
    }

    const request = this.fetchBoundPage(application, secret, pageNo, pageSize)
      .then(page => {
        const fetchedAt = Date.now();
        const entry = { page, fetchedAt, expiresAt: fetchedAt + this.boundPageCacheTtlMs };
        if ((this.boundPageCacheGenerations.get(application.id) ?? 0) === generation) {
          this.boundPageCache.set(key, entry);
          this.pruneBoundPageCache(fetchedAt);
        }
        return entry;
      })
      .finally(() => this.boundPageRequests.delete(requestKey));
    this.boundPageRequests.set(requestKey, request);
    const entry = await request;
    return { page: entry.page, fetchedAt: entry.fetchedAt, cacheStatus: 'miss' };
  }

  private boundPageCacheKey(applicationId: string, pageNo: number, pageSize: number) {
    return `${applicationId}:${pageNo}:${pageSize}`;
  }

  private pruneBoundPageCache(now = Date.now()) {
    for (const [key, entry] of this.boundPageCache) {
      if (entry.expiresAt <= now) this.boundPageCache.delete(key);
    }
    while (this.boundPageCache.size > this.boundPageCacheMaxEntries) {
      const oldest = this.boundPageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.boundPageCache.delete(oldest);
    }
  }

  private invalidateBoundPageCache(applicationId: string) {
    this.boundPageCacheGenerations.set(
      applicationId,
      (this.boundPageCacheGenerations.get(applicationId) ?? 0) + 1,
    );
    const prefix = `${applicationId}:`;
    for (const key of this.boundPageCache.keys()) {
      if (key.startsWith(prefix)) this.boundPageCache.delete(key);
    }
  }

  private async verifyBoundMappingsOnPage(
    application: BindingApplication,
    secret: string,
    requested: ValidatedLocalMapping[],
    pageNo: number,
  ): Promise<{ shops: ValidatedLocalMapping[]; failures: DidiBindingResult[] }> {
    const page = await this.fetchBoundPage(application, secret, pageNo, 100);
    const shops: ValidatedLocalMapping[] = [];
    const failures: DidiBindingResult[] = [];

    for (const requestedShop of requested) {
      const exact = page.shops.find(remote => remote.shopId === requestedShop.shopId
        && remote.appShopId === requestedShop.appShopId);
      if (exact?.bound) {
        shops.push(requestedShop);
        continue;
      }
      if (exact && !exact.bound) {
        failures.push({
          ...requestedShop,
          status: 'failed',
          reason: 'Store is not currently bound on the freshly verified DiDi page',
        });
        continue;
      }
      const sameAppShopId = page.shops.find(remote => remote.appShopId === requestedShop.appShopId);
      const sameShopId = page.shops.find(remote => remote.shopId === requestedShop.shopId);
      const mismatch = sameAppShopId
        ? `appShopId is currently bound to shopId ${sameAppShopId.shopId}`
        : sameShopId
          ? `shopId is currently bound to appShopId ${sameShopId.appShopId}`
          : `mapping is not present on freshly verified DiDi page ${pageNo}`;
      failures.push({
        ...requestedShop,
        status: 'failed',
        reason: `Remote mapping mismatch: ${mismatch}. Reload the shop list before retrying.`,
      });
    }
    return { shops, failures };
  }

  private startAudit(
    operationId: string,
    actorId: string,
    application: BindingApplication,
    action: 'bind' | 'unbind',
    shops: DidiBindingShopInput[],
    reason?: string,
  ) {
    return this.prisma.accessControlAudit.create({
      data: {
        actorId,
        scopeType: 'didi_store_binding',
        scopeKey: operationId,
        before: {
          operationId,
          action,
          applicationId: application.id,
          appIdFingerprint: fingerprintAppId(application.appId),
          environment: application.environment,
          shops,
          batchFingerprint: action === 'bind' && application.environment === 'production'
            ? fingerprintBindingBatch(shops)
            : undefined,
          reason: reason?.trim() || undefined,
          productionAcknowledged: application.environment === 'production' ? true : undefined,
        } as unknown as Prisma.InputJsonValue,
        after: { status: 'running' },
      },
      select: { id: true },
    });
  }

  private async finish(
    operationId: string,
    auditId: string,
    application: BindingApplication,
    action: 'bind' | 'unbind',
    internalResults: DidiBindingResult[],
    durationMs: number,
  ) {
    const internalSummary = summarizeBindingResults(internalResults);
    const results = internalResults.map(result => ({
      shopId: result.shopId,
      appShopId: result.appShopId,
      status: result.status,
      ...(result.status === 'success' ? { success: true } : result.status === 'failed' ? { success: false } : {}),
      ...(result.reason ? { message: result.reason, error: result.reason } : {}),
    }));
    const summary = {
      total: internalSummary.requested,
      succeeded: internalSummary.succeeded,
      failed: internalSummary.failed,
      unconfirmed: internalSummary.unconfirmed,
      skipped: 0,
      status: internalSummary.status,
    };
    let auditPersisted = true;
    try {
      await this.prisma.accessControlAudit.update({
        where: { id: auditId },
        data: {
          after: { action, summary, results, durationMs } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      auditPersisted = false;
      this.logger.error(`Could not finalize DiDi binding audit ${operationId}: ${(error as Error).message}`);
    }
    return {
      operationId,
      action,
      application: this.publicApplication(application),
      summary,
      results,
      auditPersisted,
      durationMs,
    };
  }
}
