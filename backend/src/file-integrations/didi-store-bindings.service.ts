import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountRole, DidiBindingEnvironment, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  COOLDOWN_SHOPLIST_MS,
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import { BindDidiStoresDto, ListDidiBoundStoresDto, UnbindDidiStoresDto } from './dto/didi-store-binding.dto';
import {
  buildBindRequest,
  buildListBoundStoresRequest,
  DIDI_BIND_MAX_SHOPS,
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

@Injectable()
export class DidiStoreBindingsService {
  private readonly logger = new Logger(DidiStoreBindingsService.name);
  private readonly encryptionKey: string;
  private readonly writesEnabled: boolean;
  private readonly productionBindEnabled: boolean;
  private readonly productionUnbindEnabled: boolean;
  private readonly testAppIds: Set<string>;
  private readonly requestTimeoutMs: number;
  private readonly activeApplications = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
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
  }

  async listBoundStores(
    dto: ListDidiBoundStoresDto,
    actorRoles: AccountRole[] = [],
    executePermissionAllowed = false,
  ) {
    const application = await this.application(dto.applicationId);
    const secret = decrypt(application.encryptedSecret, this.encryptionKey);
    const page = await this.fetchBoundPage(application, secret, dto.pageNo, dto.pageSize);
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
      ...page,
    };
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
    await this.assertLocalMappings(application, dto.shops);
    return this.withApplicationLock(application.id, () => this.bindLocked(dto, actorId, application));
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
      if (!response.ok) {
        throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
      }
      if (!isExplicitBindResponse(body)) {
        throw new Error(`${DIDI_BIND_STORE_ENDPOINT} returned no explicit result (HTTP ${response.status})`);
      }
      explicitDecisionReceived = true;
      results = normalizeBindResults(dto.shops, body);
    } catch (error) {
      const message = redactSensitiveText((error as Error).message, secret ? [secret] : []);
      const unconfirmed = postStarted && !explicitDecisionReceived;
      results = dto.shops.map(shop => ({
        ...shop,
        status: unconfirmed ? 'unconfirmed' : 'failed',
        reason: unconfirmed ? `${message}. Verifica estado antes de reintentar.` : message,
      }));
    }

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
    if (application.environment === 'production' && !dto.remotePageNo) {
      throw new BadRequestException(
        'Production Unbind requires remotePageNo from a freshly loaded DiDi shop-list page',
      );
    }
    const localMappings = await this.assertLocalMappings(application, dto.shops);
    return this.withApplicationLock(
      application.id,
      () => this.unbindLocked(dto, actorId, application, localMappings),
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
      // Production is anchored to both the exact local mapping and a freshly
      // re-fetched provider page chosen in the UI. This is one bounded read,
      // rather than an unbounded application-wide pagination scan.
      const resolved = application.environment === 'production'
        ? await this.verifyProductionBoundMappings(
          application,
          secret,
          localMappings,
          dto.remotePageNo as number,
        )
        : await this.resolveBoundMappings(application, secret, dto.shops);
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
          if (!response.ok) {
            throw new Error(`${DIDI_UNBIND_STORE_ENDPOINT} returned HTTP ${response.status} after submission`);
          }
          if (errno !== 0) {
            explicitDecisionReceived = true;
            throw new Error(
              `${DIDI_UNBIND_STORE_ENDPOINT} failed: ${redactSensitiveText(body?.errmsg || `HTTP ${response.status}`, [token])}`
              + ` (errno=${errno})`,
            );
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
    return this.finish(operationId, audit.id, application, 'unbind', results, Date.now() - started);
  }

  private async withApplicationLock<T>(applicationId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeApplications.has(applicationId)) {
      throw new ConflictException('Another DiDi bind/unbind operation is already running for this application');
    }
    this.activeApplications.add(applicationId);
    try {
      return await operation();
    } finally {
      this.activeApplications.delete(applicationId);
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
    const localShops = await this.prisma.shop.findMany({
      where: { shopId: { in: [...requestedByShopId.keys()] } },
      select: {
        shopId: true,
        appShopId: true,
        deletedAt: true,
        brand: { select: { applicationId: true, deletedAt: true } },
      },
    });
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
      const response = await fetchWithEndpointContext(
        DIDI_LIST_BOUND_STORES_ENDPOINT,
        `${DIDI_BASE}${DIDI_LIST_BOUND_STORES_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      responseStatus = response.status;
      responseOk = response.ok;
      body = parseJsonKeepingIds(await response.text()) as Record<string, unknown>;
      if (Number(body.errno) !== 10005 || attempt === 3) break;
      await sleep(COOLDOWN_SHOPLIST_MS);
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

  private async resolveBoundMappings(
    application: BindingApplication,
    secret: string,
    requested: DidiBindingShopInput[],
  ): Promise<{ shops: Array<{ shopId: string; appShopId: string }>; failures: DidiBindingResult[] }> {
    const pending = new Map(requested.map(shop => [shop.appShopId, shop]));
    const resolved = new Map<string, BoundShop>();
    let pageNo = 1;
    let totalPages = 1;
    do {
      const page = await this.fetchBoundPage(application, secret, pageNo, 100);
      totalPages = Math.max(1, page.totalPages);
      for (const shop of page.shops) {
        if (pending.has(shop.appShopId)) resolved.set(shop.appShopId, shop);
      }
      if (resolved.size === pending.size) break;
      pageNo += 1;
      if (pageNo <= totalPages) await sleep(COOLDOWN_SHOPLIST_MS);
    } while (pageNo <= totalPages && pageNo <= 1000);

    const shops: Array<{ shopId: string; appShopId: string }> = [];
    const failures: DidiBindingResult[] = [];
    for (const requestedShop of requested) {
      const remote = resolved.get(requestedShop.appShopId);
      if (!remote || !remote.bound) {
        failures.push({ ...requestedShop, status: 'failed', reason: 'Store is not currently bound to this application' });
      } else if (requestedShop.shopId && requestedShop.shopId !== remote.shopId) {
        failures.push({
          ...requestedShop,
          status: 'failed',
          reason: `Mapping mismatch: appShopId is bound to shopId ${remote.shopId}`,
        });
      } else {
        shops.push({ shopId: remote.shopId, appShopId: remote.appShopId });
      }
    }
    return { shops, failures };
  }

  private async verifyProductionBoundMappings(
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
