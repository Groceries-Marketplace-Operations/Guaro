import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
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
  private readonly testAppIds: Set<string>;
  private readonly requestTimeoutMs: number;
  private readonly activeApplications = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    // Only explicitly allowlisted test app IDs can reach DiDi. Production
    // remains impossible in this first release regardless of client/UI input.
    this.writesEnabled = config.get('DIDI_STORE_BINDINGS_ENABLED', 'true') === 'true';
    this.testAppIds = new Set(
      String(config.get('DIDI_STORE_BINDINGS_TEST_APP_IDS', '5764607654490537991'))
        .split(',').map((value: string) => value.trim()).filter(Boolean),
    );
    const configuredTimeout = Number(config.get('DIDI_STORE_BINDINGS_TIMEOUT_MS', '30000'));
    this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
      ? Math.min(configuredTimeout, 120_000)
      : 30_000;
  }

  async listBoundStores(dto: ListDidiBoundStoresDto) {
    const application = await this.application(dto.applicationId);
    this.assertTestApplication(application);
    const secret = decrypt(application.encryptedSecret, this.encryptionKey);
    const page = await this.fetchBoundPage(application, secret, dto.pageNo, dto.pageSize);
    return {
      application: this.publicApplication(application),
      guards: this.guardStatus(application),
      confirmation: {
        bind: 'VINCULAR N TIENDAS',
        unbind: 'DESVINCULAR N TIENDAS',
      },
      ...page,
    };
  }

  async bind(dto: BindDidiStoresDto, actorId: string) {
    this.assertUnique(dto.shops, true, DIDI_BIND_MAX_SHOPS);
    const application = await this.application(dto.applicationId);
    this.assertWriteAllowed(application, dto.confirmation, 'bind', dto.shops.length);
    return this.withApplicationLock(application.id, () => this.bindLocked(dto, actorId, application));
  }

  private async bindLocked(dto: BindDidiStoresDto, actorId: string, application: BindingApplication) {
    const operationId = randomUUID();
    const audit = await this.startAudit(operationId, actorId, application, 'bind', dto.shops);
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

  async unbind(dto: UnbindDidiStoresDto, actorId: string) {
    this.assertUnique(dto.shops, true, DIDI_UNBIND_MAX_SHOPS);
    const application = await this.application(dto.applicationId);
    this.assertWriteAllowed(application, dto.confirmation, 'unbind', dto.shops.length);
    return this.withApplicationLock(application.id, () => this.unbindLocked(dto, actorId, application));
  }

  private async unbindLocked(dto: UnbindDidiStoresDto, actorId: string, application: BindingApplication) {
    const operationId = randomUUID();
    const audit = await this.startAudit(operationId, actorId, application, 'unbind', dto.shops);
    const started = Date.now();
    let results: DidiBindingResult[] = [];
    let secret = '';

    try {
      secret = decrypt(application.encryptedSecret, this.encryptionKey);
      const resolved = await this.resolveBoundMappings(application, secret, dto.shops);
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
          explicitDecisionReceived = true;
          if (!response.ok || errno !== 0 || body?.data !== true) {
            throw new Error(
              `${DIDI_UNBIND_STORE_ENDPOINT} failed: ${redactSensitiveText(body?.errmsg || `HTTP ${response.status}`, [token])}`
              + ` (errno=${errno})`,
            );
          }
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
      select: { id: true, appId: true, appName: true, country: true, appSecret: true },
    });
    if (!application) throw new NotFoundException('Application not found');
    const namedTest = /(?:^|[_\s-])(?:t|test|sandbox)(?:[_\s-]|$)/i.test(application.appName);
    const allowlisted = this.testAppIds.has(application.appId);
    return {
      id: application.id,
      appId: application.appId,
      appName: application.appName,
      country: String(application.country),
      encryptedSecret: application.appSecret,
      environment: allowlisted ? 'test' : 'production',
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

  private guardStatus(application: BindingApplication) {
    return {
      writesEnabled: this.writesEnabled,
      productionWritesEnabled: false,
      canWrite: this.writesEnabled && application.environment === 'test',
    };
  }

  private assertWriteAllowed(
    application: BindingApplication,
    confirmation: string,
    action: 'bind' | 'unbind',
    count: number,
  ) {
    this.assertTestApplication(application);
    if (!this.writesEnabled) {
      throw new ForbiddenException('DiDi store binding writes are disabled by DIDI_STORE_BINDINGS_ENABLED');
    }
    const expected = exactConfirmation(action, count);
    if (confirmation !== expected) {
      throw new BadRequestException(`Confirmation must exactly match: ${expected}`);
    }
  }

  private assertTestApplication(application: BindingApplication) {
    if (application.environment !== 'test') {
      throw new BadRequestException('Application app_id is not in DIDI_STORE_BINDINGS_TEST_APP_IDS');
    }
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

  private startAudit(
    operationId: string,
    actorId: string,
    application: BindingApplication,
    action: 'bind' | 'unbind',
    shops: DidiBindingShopInput[],
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
