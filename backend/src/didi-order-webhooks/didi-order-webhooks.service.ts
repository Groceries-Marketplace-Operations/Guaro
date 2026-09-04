import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DidiOrderWebhookRequestStage, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { DidiStoreBindingCoordinator } from '../file-integrations/didi-store-binding-coordinator.service';
import {
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

export const DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS = 2 * 60 * 1000;
const DIDI_ORDER_CONFIRM_TIMEOUT_MS = 30_000;
const DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS = 55_000;
const DIDI_ORDER_SHOP_RESOLUTION_MAX_PAGES = 3;
const DIDI_ORDER_SHOP_RESOLUTION_RATE_LIMIT_RETRIES = 1;
const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INTEGER_ID_PATTERN = /^\d{1,20}$/;

interface DidiOrderWebhookPayload {
  appId: string;
  appShopId?: string;
  shopId?: string;
  orderId: string;
  type: 'orderNew';
  sourceTimestamp: string;
}

interface ClaimedEvent {
  id: string;
  status: 'processing' | 'accepted' | 'failed';
  appShopId: string;
  claimed: boolean;
}

interface ConfirmResult {
  httpStatus: number;
  errno: number;
  errmsg: string | null;
}

class DidiOrderConfirmError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
    readonly errno: number | null = null,
    readonly errmsg: string | null = null,
  ) {
    super(message);
  }
}

export function buildDidiOrderConfirmBody(authToken: string, orderId: string) {
  if (!INTEGER_ID_PATTERN.test(orderId)) {
    throw new Error('order_id must be an unsigned decimal integer of at most 20 digits');
  }
  // order_id is an int64 in DiDi. Serializing Number(orderId) would silently
  // round values above Number.MAX_SAFE_INTEGER, so emit the validated digits as
  // a JSON numeric literal.
  return `{"auth_token":${JSON.stringify(authToken)},"order_id":${orderId}}`;
}

export function parseDidiOrderWebhookPayload(rawBody: Buffer): DidiOrderWebhookPayload {
  if (rawBody.length === 0) throw new BadRequestException('Webhook body is required');
  if (rawBody.length > DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES) {
    throw new PayloadTooLargeException('Webhook body exceeds the 1 MiB limit');
  }

  let parsed: unknown;
  try {
    parsed = parseJsonKeepingIds(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException('Webhook body must be valid JSON');
  }
  const root = asRecord(parsed, 'Webhook body');
  const type = requiredString(root.type, 'type');
  if (type !== 'orderNew') throw new BadRequestException('type must be orderNew');

  const appId = requiredIntegerId(root.app_id, 'app_id');
  const rootAppShopId = optionalAppShopId(root.app_shop_id, 'app_shop_id');
  const sourceTimestamp = requiredTimestamp(root.timestamp);
  const data = asRecord(root.data, 'data');
  const orderId = requiredIntegerId(data.order_id, 'data.order_id');
  const orderInfo = asRecord(data.order_info, 'data.order_info');
  const nestedOrderId = requiredIntegerId(orderInfo.order_id, 'data.order_info.order_id');
  if (nestedOrderId !== orderId) {
    throw new BadRequestException('data.order_id does not match data.order_info.order_id');
  }
  const nestedShop = asRecord(orderInfo.shop, 'data.order_info.shop');
  const nestedAppShopId = optionalAppShopId(
    nestedShop.app_shop_id,
    'data.order_info.shop.app_shop_id',
  );
  if (rootAppShopId && nestedAppShopId && nestedAppShopId !== rootAppShopId) {
    throw new BadRequestException(
      'app_shop_id does not match data.order_info.shop.app_shop_id',
    );
  }
  const appShopId = rootAppShopId ?? nestedAppShopId;
  const shopId = optionalIntegerId(nestedShop.shop_id, 'data.order_info.shop.shop_id');
  if (!appShopId && !shopId) {
    throw new BadRequestException(
      'app_shop_id or data.order_info.shop.shop_id is required',
    );
  }

  return {
    appId,
    ...(appShopId ? { appShopId } : {}),
    ...(shopId ? { shopId } : {}),
    orderId,
    type,
    sourceTimestamp,
  };
}

@Injectable()
export class DidiOrderWebhooksService {
  private readonly encryptionKey: string;
  private readonly shopListCoordinator: DidiStoreBindingCoordinator;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() shopListCoordinator?: DidiStoreBindingCoordinator,
  ) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.shopListCoordinator = shopListCoordinator ?? new DidiStoreBindingCoordinator();
  }

  async receive(token: string, rawBody: Buffer | undefined) {
    if (!WEBHOOK_TOKEN_PATTERN.test(token)) throw new NotFoundException('Order webhook not found');

    const application = await this.prisma.application.findFirst({
      where: {
        orderWebhookTokenHash: hashToken(token),
        orderWebhookTokenEncrypted: { not: null },
        orderWebhookDisabledAt: null,
        deletedAt: null,
      },
      select: { id: true, appId: true, appSecret: true },
    });
    if (!application) throw new NotFoundException('Order webhook not found');
    const requestStartedAt = Date.now();
    const requestLog = await this.prisma.didiOrderWebhookRequest.create({
      data: { applicationId: application.id },
      select: { id: true },
    });
    let stage: DidiOrderWebhookRequestStage = 'received';
    let eventId: string | null = null;
    let remote: DidiOrderConfirmError | null = null;
    let failureDetail: string | null = null;
    const auditSecrets: string[] = [];

    try {
      if (!rawBody) throw new BadRequestException('Raw webhook body is unavailable');
      stage = 'validation';
      const payload = parseDidiOrderWebhookPayload(rawBody);
      if (payload.appId !== application.appId) {
        throw new BadRequestException('Payload app_id does not match webhook application');
      }

      stage = 'shop_resolution';
      await this.prisma.didiOrderWebhookRequest.update({
        where: { id: requestLog.id },
        data: {
          stage,
          appShopId: payload.appShopId ?? null,
          orderId: payload.orderId,
          type: payload.type,
        },
      });
      let appSecret: string | null = null;
      const applicationSecret = () => {
        if (appSecret) return appSecret;
        try {
          appSecret = decrypt(application.appSecret, this.encryptionKey);
        } catch {
          throw new Error('Application credential could not be decrypted');
        }
        auditSecrets.push(appSecret);
        return appSecret;
      };
      let appShopId = payload.appShopId;
      let shops = appShopId
        ? await this.prisma.shop.findMany({
          where: {
            appShopId,
            ...(payload.shopId ? { shopId: payload.shopId } : {}),
            deletedAt: null,
            brand: { applicationId: application.id, deletedAt: null },
          },
          select: { id: true },
          take: 2,
        })
        : [];
      if (shops.length !== 1 && payload.shopId) {
        try {
          const remoteAppShopId = await this.resolveRemoteAppShopId(
            application.id,
            application.appId,
            applicationSecret(),
            payload.shopId,
          );
          if (!remoteAppShopId) {
            throw new BadRequestException(
              'data.order_info.shop.shop_id was not found in the webhook application shop list',
            );
          }
          if (payload.appShopId && payload.appShopId !== remoteAppShopId) {
            throw new BadRequestException(
              'Payload app_shop_id does not match the application shop-list mapping for shop_id',
            );
          }
          appShopId = requiredAppShopId(
            remoteAppShopId,
            'Resolved app_shop_id',
          );
        } catch (error) {
          if (error instanceof HttpException) throw error;
          failureDetail = safeError(error, auditSecrets);
          throw new BadGatewayException('DiDi shop resolution failed');
        }
        await this.prisma.didiOrderWebhookRequest.update({
          where: { id: requestLog.id },
          data: { appShopId },
        });
        shops = await this.prisma.shop.findMany({
          where: {
            shopId: payload.shopId,
            deletedAt: null,
            brand: { applicationId: application.id, deletedAt: null },
          },
          select: { id: true },
          take: 2,
        });
      }
      if (!appShopId || shops.length !== 1) {
        throw new BadRequestException(
          'Webhook shop must resolve to exactly one active shop for the webhook application',
        );
      }
      const resolvedPayload: DidiOrderWebhookPayload & { appShopId: string } = {
        ...payload,
        appShopId,
      };

      stage = 'idempotency';
      await this.prisma.didiOrderWebhookRequest.update({
        where: { id: requestLog.id },
        data: { stage },
      });
      const event = await this.claimEvent(application.id, shops[0].id, resolvedPayload);
      eventId = event.id;
      await this.prisma.didiOrderWebhookRequest.update({
        where: { id: requestLog.id },
        data: { eventId },
      });
      if (!event.claimed) {
        await this.completeRequest(requestLog.id, requestStartedAt, {
          stage: 'completed',
          outcome: 'deduplicated',
          localHttpStatus: HttpStatus.OK,
          eventId,
        });
        return {
          accepted: event.status === 'accepted',
          deduplicated: true,
          orderId: payload.orderId,
          appShopId: event.appShopId,
          status: event.status,
        };
      }

      let confirmed: ConfirmResult;
      try {
        stage = 'authentication';
        await this.prisma.didiOrderWebhookRequest.update({
          where: { id: requestLog.id },
          data: { stage },
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DIDI_ORDER_CONFIRM_TIMEOUT_MS);
        try {
          const authToken = await getAuthToken(
            application.appId,
            applicationSecret(),
            appShopId,
            controller.signal,
          );
          auditSecrets.push(authToken);
          stage = 'confirmation';
          await this.prisma.didiOrderWebhookRequest.update({
            where: { id: requestLog.id },
            data: { stage },
          });
          confirmed = await this.confirmOrder(authToken, payload.orderId, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        remote = error instanceof DidiOrderConfirmError ? error : null;
        failureDetail = safeError(error, auditSecrets);
        await this.prisma.didiOrderWebhookEvent.update({
          where: { id: event.id },
          data: {
            status: 'failed',
            failedAt: new Date(),
            remoteHttpStatus: remote?.httpStatus ?? null,
            remoteErrno: remote?.errno ?? null,
            remoteErrmsg: sanitizeAuditText(remote?.errmsg),
            errorMessage: failureDetail,
          },
        });
        throw new BadGatewayException('DiDi order confirmation failed');
      }

      await this.prisma.didiOrderWebhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'accepted',
          acceptedAt: new Date(),
          failedAt: null,
          remoteHttpStatus: confirmed.httpStatus,
          remoteErrno: confirmed.errno,
          remoteErrmsg: sanitizeAuditText(confirmed.errmsg),
          errorMessage: null,
        },
      });
      await this.completeRequest(requestLog.id, requestStartedAt, {
        stage: 'completed',
        outcome: 'accepted',
        localHttpStatus: HttpStatus.OK,
        eventId,
        remoteHttpStatus: confirmed.httpStatus,
        remoteErrno: confirmed.errno,
        remoteErrmsg: sanitizeAuditText(confirmed.errmsg),
        errorMessage: null,
      });
      return {
        accepted: true,
        deduplicated: false,
        orderId: payload.orderId,
        appShopId,
        status: 'accepted' as const,
      };
    } catch (error) {
      const localHttpStatus = error instanceof HttpException ? error.getStatus() : 500;
      const recordedRemote = remote as DidiOrderConfirmError | null;
      await this.completeRequest(requestLog.id, requestStartedAt, {
        stage,
        outcome: localHttpStatus >= 500 ? 'failed' : 'rejected',
        localHttpStatus,
        eventId,
        remoteHttpStatus: recordedRemote?.httpStatus ?? null,
        remoteErrno: recordedRemote?.errno ?? null,
        remoteErrmsg: sanitizeAuditText(recordedRemote?.errmsg),
        errorMessage: failureDetail ?? safeError(error, auditSecrets),
      });
      throw error;
    }
  }

  private completeRequest(
    id: string,
    startedAt: number,
    data: Prisma.DidiOrderWebhookRequestUncheckedUpdateInput,
  ) {
    return this.prisma.didiOrderWebhookRequest.update({
      where: { id },
      data: {
        ...data,
        durationMs: Math.min(2_147_483_647, Math.max(0, Date.now() - startedAt)),
        completedAt: new Date(),
      },
    });
  }

  private async resolveRemoteAppShopId(
    applicationId: string,
    appId: string,
    appSecret: string,
    shopId: string,
  ) {
    const signal = AbortSignal.timeout(DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS);
    const remoteShops = await this.shopListCoordinator.withShopListRateLimit(
      applicationId,
      () => fetchShopIdMap(appId, appSecret, [shopId], {
        signal,
        maxPages: DIDI_ORDER_SHOP_RESOLUTION_MAX_PAGES,
        maxRateLimitRetries: DIDI_ORDER_SHOP_RESOLUTION_RATE_LIMIT_RETRIES,
      }),
      signal,
    );
    return remoteShops.get(shopId);
  }

  private async claimEvent(
    applicationId: string,
    shopId: string,
    payload: DidiOrderWebhookPayload & { appShopId: string },
  ): Promise<ClaimedEvent> {
    try {
      const created = await this.prisma.didiOrderWebhookEvent.create({
        data: {
          applicationId,
          shopId,
          appShopId: payload.appShopId,
          orderId: payload.orderId,
          type: payload.type,
          sourceTimestamp: payload.sourceTimestamp,
        },
        select: { id: true, status: true, appShopId: true },
      });
      return { ...created, claimed: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }

    const where = {
      applicationId_orderId_type: {
        applicationId,
        orderId: payload.orderId,
        type: payload.type,
      },
    };
    let existing = await this.prisma.didiOrderWebhookEvent.findUnique({
      where,
      select: { id: true, status: true, appShopId: true, startedAt: true },
    });
    if (!existing) throw new Error('Idempotency record disappeared after unique conflict');
    if (existing.appShopId !== payload.appShopId) {
      throw new BadRequestException('order_id was previously received for another app_shop_id');
    }
    if (existing.status === 'accepted') return { ...existing, claimed: false };

    const staleBefore = new Date(Date.now() - DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS);
    const reclaimableWhere = existing.status === 'failed'
      ? { id: existing.id, status: 'failed' as const }
      : { id: existing.id, status: 'processing' as const, startedAt: { lt: staleBefore } };
    const reclaimed = await this.prisma.didiOrderWebhookEvent.updateMany({
      where: reclaimableWhere,
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        shopId,
        sourceTimestamp: payload.sourceTimestamp,
        startedAt: new Date(),
        acceptedAt: null,
        failedAt: null,
        remoteHttpStatus: null,
        remoteErrno: null,
        remoteErrmsg: null,
        errorMessage: null,
      },
    });
    if (reclaimed.count === 1) {
      return { id: existing.id, status: 'processing', appShopId: existing.appShopId, claimed: true };
    }

    existing = await this.prisma.didiOrderWebhookEvent.findUnique({
      where,
      select: { id: true, status: true, appShopId: true, startedAt: true },
    });
    if (!existing) throw new Error('Idempotency record disappeared while claiming');
    return { ...existing, claimed: false };
  }

  private async confirmOrder(
    authToken: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<ConfirmResult> {
    const endpoint = 'POST /v1/order/order/confirm';
    const response = await fetchWithEndpointContext(
      endpoint,
      `${DIDI_BASE}/v1/order/order/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildDidiOrderConfirmBody(authToken, orderId),
        signal,
      },
    );
    const raw = await response.text();
    let body: Record<string, unknown>;
    try {
      body = asRecord(parseJsonKeepingIds(raw), 'DiDi response');
    } catch {
      throw new DidiOrderConfirmError(
        `${endpoint} returned invalid JSON`,
        response.status,
      );
    }
    const errno = typeof body.errno === 'number' && Number.isInteger(body.errno)
      ? body.errno
      : typeof body.errno === 'string' && /^\d+$/.test(body.errno)
        ? Number(body.errno)
        : Number.NaN;
    const errmsg = sanitizeAuditText(
      typeof body.errmsg === 'string' ? body.errmsg : null,
      1000,
      [authToken],
    );
    if (!response.ok || !Number.isInteger(errno) || errno !== 0) {
      throw new DidiOrderConfirmError(
        `${endpoint} failed: ${errmsg ?? `HTTP ${response.status}`} (errno=${Number.isInteger(errno) ? errno : 'unknown'})`,
        response.status,
        Number.isInteger(errno) ? errno : null,
        errmsg,
      );
    }
    return { httpStatus: response.status, errno, errmsg };
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredIntegerId(value: unknown, label: string) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
  if (!INTEGER_ID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label} must be an unsigned decimal integer of at most 20 digits`);
  }
  return normalized;
}

function requiredAppShopId(value: unknown, label: string) {
  const normalized = requiredString(value, label);
  if (normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return normalized;
}

function optionalAppShopId(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return undefined;
  return requiredAppShopId(value, label);
}

function optionalIntegerId(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return undefined;
  return requiredIntegerId(value, label);
}

function requiredTimestamp(value: unknown) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
  if (!/^\d{10,16}$/.test(normalized)) {
    throw new BadRequestException('timestamp must be a Unix timestamp');
  }
  return normalized;
}

function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    || (typeof error === 'object' && error !== null && 'code' in error)
  ) && (error as { code?: string }).code === 'P2002';
}

function safeError(error: unknown, secrets: string[] = []) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeAuditText(message, 2000, secrets) ?? 'Unknown error';
}

function sanitizeAuditText(
  value: string | null | undefined,
  limit = 1000,
  secrets: string[] = [],
) {
  if (!value) return null;
  let sanitized = value
    .replace(/((?:auth_token|app_secret|refresh_token|authorization)\s*[=:]\s*)[^\s,;}&]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,;}&]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[REDACTED_TOKEN]');
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized.slice(0, limit);
}
