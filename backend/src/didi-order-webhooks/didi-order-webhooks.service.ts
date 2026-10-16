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
import {
  DidiOrderWebhookRequestStage,
  DidiOrderWebhookShopResolutionSource,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { DidiStoreBindingCoordinator } from '../file-integrations/didi-store-binding-coordinator.service';
import {
  calculateDidiOrderFinancialSnapshot,
  DidiOrderFinancialSnapshot,
} from './didi-order-webhook-finance.util';
import {
  DIDI_BASE,
  fetchShopIdMap,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

export const DIDI_ORDER_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS = 10_000;
const DIDI_ORDER_CONFIRM_TIMEOUT_MS = 30_000;
export const DIDI_ORDER_ACCEPTANCE_TIMEOUT_MS = 190_000;
// A live request must never be reclaimed while it can still be resolving or
// confirming. Keep an explicit recovery margin for final audit persistence.
export const DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS =
  DIDI_ORDER_ACCEPTANCE_TIMEOUT_MS + 50_000;
export const DIDI_ORDER_FINAL_AUDIT_RESERVE_MS = 5_000;
export const DIDI_ORDER_CONFIRM_RESERVE_MS = 35_000;
export const DIDI_ORDER_REMOTE_RESOLUTION_RESERVE_MS = 65_000;
export const DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS = 150_000;
export const DIDI_ORDER_SHOP_RESOLUTION_MAX_PAGES = 5;
export const DIDI_ORDER_SHOP_RESOLUTION_RATE_LIMIT_RETRIES = 1;
const DIDI_ORDER_SHOP_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
const DIDI_ORDER_SHOP_RESOLUTION_CACHE_MAX_ENTRIES = 5_000;
const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INTEGER_ID_PATTERN = /^\d{1,20}$/;

interface DidiOrderWebhookPayload {
  appId: string;
  appShopId?: string;
  shopId?: string;
  orderId: string;
  type: 'orderNew';
  sourceTimestamp: string;
  orderPriceMinor: bigint | null;
  realPriceMinor: bigint | null;
  realPayPriceMinor: bigint | null;
}
interface ClaimedEvent {
  id: string;
  status: 'processing' | 'accepted' | 'failed';
  appShopId: string;
  didiShopId: string | null;
  acceptedCount: number;
  confirmationCalls: number;
  profitMxn: Prisma.Decimal | null;
  claimed: boolean;
}

interface ConfirmResult {
  httpStatus: number;
  errno: number;
  errmsg: string | null;
}

interface ShopAcceptanceCandidate {
  appShopId: string;
  didiShopId: string;
  localShopId: string | null;
  remoteShopValidated: boolean;
  shopResolutionSource: DidiOrderWebhookShopResolutionSource;
}

type DidiOrderPersistenceClient = Pick<
  Prisma.TransactionClient,
  'didiOrderWebhookRequest' | '$queryRaw'
>;

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

export function getRemainingDidiOrderTimeoutMs(
  deadlineAt: number,
  maxTimeoutMs: number,
) {
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    throw new Error('DiDi order acceptance deadline exceeded');
  }
  return Math.max(1, Math.min(maxTimeoutMs, remainingMs));
}

export function waitForDidiOrderDeadline<T>(
  promise: Promise<T>,
  deadlineAt?: number,
): Promise<T> {
  if (deadlineAt === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void promise.then(
      value => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      },
      error => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      },
    );
    try {
      const timeoutMs = getRemainingDidiOrderTimeoutMs(
        deadlineAt,
        DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS,
      );
      timeout = setTimeout(
        () => reject(new Error('DiDi order acceptance deadline exceeded')),
        timeoutMs,
      );
    } catch (error) {
      reject(error);
    }
  });
}

function parseDidiOrderWebhookEnvelope(rawBody: Buffer) {
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
  // Only an exact top-level discriminator is accepted. Nested text must never
  // make an unrelated delivery look like an orderNew event.
  if (root.type !== 'orderNew') throw new BadRequestException('type must be orderNew');
  return root;
}

function parseDidiOrderWebhookRoot(root: Record<string, unknown>): DidiOrderWebhookPayload {
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
  // Price data is reporting metadata, not part of the acceptance identity.
  // Providers have historically sent missing, partial and unexpectedly typed
  // price blocks, so malformed values must never prevent an orderNew from
  // reaching confirmation.
  const price = orderInfo.price
    && typeof orderInfo.price === 'object'
    && !Array.isArray(orderInfo.price)
    ? orderInfo.price as Record<string, unknown>
    : null;

  return {
    appId,
    ...(appShopId ? { appShopId } : {}),
    ...(shopId ? { shopId } : {}),
    orderId,
    type: 'orderNew',
    sourceTimestamp,
    orderPriceMinor: optionalMoneyMinor(
      price?.order_price,
      'data.order_info.price.order_price',
    ),
    realPriceMinor: optionalMoneyMinor(
      price?.real_price,
      'data.order_info.price.real_price',
    ),
    realPayPriceMinor: optionalMoneyMinor(
      price?.real_pay_price,
      'data.order_info.price.real_pay_price',
    ),
  };
}

export function parseDidiOrderWebhookPayload(rawBody: Buffer): DidiOrderWebhookPayload {
  return parseDidiOrderWebhookRoot(parseDidiOrderWebhookEnvelope(rawBody));
}

@Injectable()
export class DidiOrderWebhooksService {
  private readonly encryptionKey: string;
  private readonly shopListCoordinator: DidiStoreBindingCoordinator;
  private readonly remoteShopResolutionCache = new Map<
    string,
    { appShopId: string; expiresAt: number }
  >();
  private readonly remoteShopResolutionInFlight = new Map<string, Promise<string | undefined>>();
  private readonly remoteShopResolutionCacheWriters = new Map<string, symbol>();
  // Kept as an instance seam so the webhook-level tests can assert that the
  // bounded provider lookup receives the production limits.
  private fetchRemoteShopIdMap = fetchShopIdMap;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() shopListCoordinator?: DidiStoreBindingCoordinator,
  ) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.shopListCoordinator = shopListCoordinator ?? new DidiStoreBindingCoordinator();
  }

  async receive(token: string, rawBody: Buffer | undefined) {
    const requestStartedAt = Date.now();
    const acceptanceDeadlineAt = requestStartedAt + DIDI_ORDER_ACCEPTANCE_TIMEOUT_MS;
    const preConfirmationDeadlineAt = acceptanceDeadlineAt - DIDI_ORDER_CONFIRM_RESERVE_MS;
    const remoteResolutionDeadlineAt = acceptanceDeadlineAt
      - DIDI_ORDER_REMOTE_RESOLUTION_RESERVE_MS;
    if (!WEBHOOK_TOKEN_PATTERN.test(token)) throw new NotFoundException('Order webhook not found');

    const application = await this.prisma.application.findFirst({
      where: {
        orderWebhookTokenHash: hashToken(token),
        orderWebhookTokenEncrypted: { not: null },
        orderWebhookDisabledAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        appId: true,
        appSecret: true,
        country: true,
        orderWebhookProfitMode: true,
        orderWebhookProfitValue: true,
        orderWebhookNativeToMxn: true,
        orderWebhookMxnPerUsd: true,
      },
    });
    if (!application) throw new NotFoundException('Order webhook not found');
    if (!rawBody) throw new BadRequestException('Raw webhook body is unavailable');
    const webhookRoot = parseDidiOrderWebhookEnvelope(rawBody);
    const requestLog = await this.prisma.didiOrderWebhookRequest.create({
      data: { applicationId: application.id, type: 'orderNew' },
      select: { id: true },
    });
    let stage: DidiOrderWebhookRequestStage = 'received';
    let eventId: string | null = null;
    let remote: DidiOrderConfirmError | null = null;
    let failureDetail: string | null = null;
    const auditSecrets: string[] = [];

    try {
      stage = 'validation';
      const payload = parseDidiOrderWebhookRoot(webhookRoot);
      if (payload.appId !== application.appId) {
        throw new BadRequestException('Payload app_id does not match webhook application');
      }

      stage = 'shop_resolution';
      await this.prisma.didiOrderWebhookRequest.update({
        where: { id: requestLog.id },
        data: {
          stage,
          appShopId: payload.appShopId ?? null,
          didiShopId: payload.shopId ?? null,
          orderId: payload.orderId,
          type: payload.type,
        },
      });
      const duplicate = await this.findResolvedDuplicate(
        application.id,
        payload,
        acceptanceDeadlineAt,
      );
      if (duplicate) {
        eventId = duplicate.id;
        await this.prisma.didiOrderWebhookRequest.update({
          where: { id: requestLog.id },
          data: {
            eventId,
            appShopId: duplicate.appShopId,
            didiShopId: duplicate.didiShopId,
            remoteShopValidated: duplicate.remoteShopValidated,
            shopResolutionSource: duplicate.shopResolutionSource,
          },
        });
        await this.completeRequest(requestLog.id, requestStartedAt, {
          stage: 'completed',
          outcome: 'deduplicated',
          localHttpStatus: HttpStatus.OK,
          eventId,
          profitRecognized: false,
        });
        return {
          accepted: duplicate.acceptedCount > 0,
          deduplicated: true,
          orderId: payload.orderId,
          appShopId: duplicate.appShopId,
          status: duplicate.status,
        };
      }
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
      let candidate: ShopAcceptanceCandidate;
      try {
        candidate = payload.shopId && payload.appShopId
          ? await this.resolvePayloadShopCandidate(
            application.id,
            payload.shopId,
            payload.appShopId,
          )
          : await this.resolveInitialShopCandidate(
            application.id,
            application.appId,
            applicationSecret,
            payload,
            remoteResolutionDeadlineAt,
          );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        failureDetail = safeError(error, auditSecrets);
        throw new BadGatewayException('DiDi shop resolution failed');
      }

      const resolvedPayload: DidiOrderWebhookPayload & { appShopId: string } = {
        ...payload,
        appShopId: candidate.appShopId,
      };
      const financials = calculateDidiOrderFinancialSnapshot(
        application.country,
        payload.realPayPriceMinor,
        application,
      );

      stage = 'idempotency';
      await this.prisma.didiOrderWebhookRequest.update({
        where: { id: requestLog.id },
        data: {
          stage,
          appShopId: candidate.appShopId,
          didiShopId: candidate.didiShopId,
          remoteShopValidated: candidate.remoteShopValidated,
          shopResolutionSource: candidate.shopResolutionSource,
        },
      });
      const event = await this.claimEvent(
        application.id,
        candidate.localShopId,
        candidate.didiShopId,
        candidate.remoteShopValidated,
        candidate.shopResolutionSource,
        resolvedPayload,
        financials,
      );
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
          profitRecognized: false,
        });
        return {
          accepted: event.acceptedCount > 0,
          deduplicated: true,
          orderId: payload.orderId,
          appShopId: event.appShopId,
          status: event.status,
        };
      }

      const authenticateCandidate = async (
        selected: ShopAcceptanceCandidate,
        persistOnEvent: boolean,
      ) => {
        if (persistOnEvent) {
          await this.prisma.didiOrderWebhookEvent.update({
            where: { id: event.id },
            data: {
              shopId: selected.localShopId,
              didiShopId: selected.didiShopId,
              appShopId: selected.appShopId,
              remoteShopValidated: selected.remoteShopValidated,
              shopResolutionSource: selected.shopResolutionSource,
            },
          });
        }
        stage = 'authentication';
        await this.prisma.didiOrderWebhookRequest.update({
          where: { id: requestLog.id },
          data: {
            stage,
            appShopId: selected.appShopId,
            didiShopId: selected.didiShopId,
            remoteShopValidated: selected.remoteShopValidated,
            shopResolutionSource: selected.shopResolutionSource,
          },
        });
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          getRemainingDidiOrderTimeoutMs(
            preConfirmationDeadlineAt,
            DIDI_ORDER_CONFIRM_TIMEOUT_MS,
          ),
        );
        try {
          const authToken = await getAuthToken(
            application.appId,
            applicationSecret(),
            selected.appShopId,
            controller.signal,
          );
          if (typeof authToken !== 'string' || !authToken) {
            throw new Error('DiDi auth token is unavailable');
          }
          auditSecrets.push(authToken);
          return authToken;
        } finally {
          clearTimeout(timeout);
        }
      };

      const fallbackDidiShopId = candidate.didiShopId;
      const triedAppShopIds = new Set([candidate.appShopId]);
      const alternativeResolvers: Array<() => Promise<ShopAcceptanceCandidate | null>> = [
        () => this.resolveLocalAlternativeShopCandidate(
          application.id,
          fallbackDidiShopId,
          triedAppShopIds,
        ),
        () => this.resolveInventoryAlternativeShopCandidate(
          application.id,
          fallbackDidiShopId,
          triedAppShopIds,
        ),
        () => this.resolveRemoteAlternativeShopCandidate(
          application.id,
          application.appId,
          applicationSecret,
          fallbackDidiShopId,
          triedAppShopIds,
          remoteResolutionDeadlineAt,
        ),
      ];
      let alternativeIndex = 0;
      let lastAuthError: unknown;

      const nextAlternative = async () => {
        while (alternativeIndex < alternativeResolvers.length) {
          stage = 'shop_resolution';
          await this.prisma.didiOrderWebhookRequest.update({
            where: { id: requestLog.id },
            data: { stage },
          });
          const alternative = await alternativeResolvers[alternativeIndex++]();
          if (!alternative || triedAppShopIds.has(alternative.appShopId)) continue;
          triedAppShopIds.add(alternative.appShopId);
          return alternative;
        }
        return null;
      };

      const authenticateAvailableCandidate = async (
        initial: { selected: ShopAcceptanceCandidate; persistOnEvent: boolean } | null,
      ): Promise<{ selected: ShopAcceptanceCandidate; authToken: string } | null> => {
        let attempt = initial;
        while (attempt) {
          try {
            return {
              selected: attempt.selected,
              authToken: await authenticateCandidate(
                attempt.selected,
                attempt.persistOnEvent,
              ),
            };
          } catch (authError) {
            lastAuthError = authError;
          }
          const alternative = await nextAlternative();
          attempt = alternative ? { selected: alternative, persistOnEvent: true } : null;
        }
        if (lastAuthError) stage = 'authentication';
        return null;
      };

      const confirmAuthenticatedCandidate = async (authToken: string) => {
        stage = 'confirmation';
        await this.prisma.didiOrderWebhookRequest.update({
          where: { id: requestLog.id },
          data: { stage },
        });
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          getRemainingDidiOrderTimeoutMs(
            acceptanceDeadlineAt - DIDI_ORDER_FINAL_AUDIT_RESERVE_MS,
            DIDI_ORDER_CONFIRM_TIMEOUT_MS,
          ),
        );
        try {
          return await this.confirmReservedOrder(
            event.id,
            authToken,
            payload.orderId,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
      };

      let authenticated: { selected: ShopAcceptanceCandidate; authToken: string } | null;
      try {
        authenticated = await authenticateAvailableCandidate({
          selected: candidate,
          persistOnEvent: false,
        });
      } catch (error) {
        failureDetail = safeError(error, auditSecrets);
        await this.markEventAttemptFailed(event, null, failureDetail);
        if (error instanceof HttpException) throw error;
        throw new BadGatewayException('DiDi fallback shop resolution failed');
      }
      if (!authenticated) {
        stage = 'authentication';
        failureDetail = safeError(lastAuthError, auditSecrets);
        await this.markEventAttemptFailed(event, null, failureDetail);
        throw new BadGatewayException('DiDi order authentication failed');
      }

      let confirmed: ConfirmResult | null = null;
      while (authenticated) {
        candidate = authenticated.selected;
        try {
          confirmed = await confirmAuthenticatedCandidate(authenticated.authToken);
          break;
        } catch (error) {
          const explicitRejection = isExplicitSafeDidiOrderRejection(error);
          if (!explicitRejection) {
            remote = error instanceof DidiOrderConfirmError ? error : null;
            failureDetail = safeError(error, auditSecrets);
            await this.markEventAttemptFailed(event, remote, failureDetail);
            throw new BadGatewayException('DiDi order confirmation failed');
          }
          remote = error;
          try {
            const alternative = await nextAlternative();
            if (!alternative) {
              stage = 'confirmation';
              authenticated = null;
            } else {
              authenticated = await authenticateAvailableCandidate({
                  selected: alternative,
                  persistOnEvent: true,
                });
            }
          } catch (fallbackError) {
            failureDetail = safeError(fallbackError, auditSecrets);
            await this.markEventAttemptFailed(event, remote, failureDetail);
            throw new BadGatewayException('DiDi fallback shop resolution failed');
          }
        }
      }
      if (!confirmed || !authenticated) {
        failureDetail = safeError(remote ?? lastAuthError, auditSecrets);
        await this.markEventAttemptFailed(event, remote, failureDetail);
        throw new BadGatewayException('DiDi order confirmation failed');
      }

      const acceptedRequest = {
        stage: 'completed' as const,
        outcome: 'accepted' as const,
        localHttpStatus: HttpStatus.OK,
        eventId,
        remoteHttpStatus: confirmed.httpStatus,
        remoteErrno: confirmed.errno,
        remoteErrmsg: sanitizeAuditText(confirmed.errmsg),
        errorMessage: null,
        // Profit is recognized once per unique order, never for a later
        // webhook that only occupies the second confirmation slot.
        profitRecognized: event.acceptedCount === 0 && event.profitMxn !== null,
      } satisfies Prisma.DidiOrderWebhookRequestUncheckedUpdateInput;
      await this.acceptEventAndCompleteRequest(
        event,
        confirmed,
        requestLog.id,
        requestStartedAt,
        acceptedRequest,
      );

      await this.tryAutomaticSecondConfirmation({
        event: {
          ...event,
          acceptedCount: event.acceptedCount + 1,
          confirmationCalls: Math.max(event.confirmationCalls, event.acceptedCount) + 1,
        },
        candidate,
        authToken: authenticated.authToken,
        orderId: payload.orderId,
        sourceTimestamp: payload.sourceTimestamp,
        requestId: requestLog.id,
        requestStartedAt,
        acceptedRequest,
        acceptanceDeadlineAt,
      });
      return {
        accepted: true,
        deduplicated: false,
        orderId: payload.orderId,
        appShopId: candidate.appShopId,
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
        profitRecognized: false,
      });
      throw error;
    }
  }

  private completeRequest(
    id: string,
    startedAt: number,
    data: Prisma.DidiOrderWebhookRequestUncheckedUpdateInput,
    client: DidiOrderPersistenceClient = this.prisma,
  ) {
    return client.didiOrderWebhookRequest.update({
      where: { id },
      data: {
        ...data,
        durationMs: Math.min(2_147_483_647, Math.max(0, Date.now() - startedAt)),
        completedAt: new Date(),
      },
    });
  }

  private async markEventAttemptFailed(
    event: ClaimedEvent,
    remote: DidiOrderConfirmError | null,
    failureDetail: string | null,
  ) {
    await this.prisma.didiOrderWebhookEvent.updateMany({
      where: {
        id: event.id,
        status: 'processing',
        acceptedCount: event.acceptedCount,
      },
      data: event.acceptedCount > 0
        ? { status: 'accepted' }
        : {
            status: 'failed',
            failedAt: new Date(),
            remoteHttpStatus: remote?.httpStatus ?? null,
            remoteErrno: remote?.errno ?? null,
            remoteErrmsg: sanitizeAuditText(remote?.errmsg),
            errorMessage: failureDetail,
          },
    });
  }

  private async markEventAccepted(
    event: ClaimedEvent,
    confirmed: ConfirmResult,
    client: DidiOrderPersistenceClient = this.prisma,
  ) {
    const updated = await client.$queryRaw<Array<{ acceptedCount: number }>>(Prisma.sql`
      UPDATE "didi_order_webhook_event"
      SET
        "status" = 'accepted'::"DidiOrderWebhookStatus",
        "accepted_count" = "accepted_count" + 1,
        "accepted_at" = CURRENT_TIMESTAMP,
        "failed_at" = NULL,
        "remote_http_status" = ${confirmed.httpStatus},
        "remote_errno" = ${confirmed.errno},
        "remote_errmsg" = ${sanitizeAuditText(confirmed.errmsg)},
        "error_message" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${event.id}::uuid
        AND "status" = 'processing'::"DidiOrderWebhookStatus"
        AND "accepted_count" = ${event.acceptedCount}
        AND "accepted_count" < 2
        AND "confirmation_calls" > "accepted_count"
      RETURNING "accepted_count" AS "acceptedCount"
    `);
    if (updated.length !== 1) {
      throw new Error('Order webhook acceptance slot was lost before completion');
    }
  }

  private async reserveConfirmationCall(eventId: string) {
    const reserved = await this.prisma.$queryRaw<Array<{ confirmationCall: number }>>(Prisma.sql`
      UPDATE "didi_order_webhook_event"
      SET
        "confirmation_calls" = GREATEST("confirmation_calls", "accepted_count") + 1,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${eventId}::uuid
        AND "status" = 'processing'::"DidiOrderWebhookStatus"
        AND GREATEST("confirmation_calls", "accepted_count") < 2
      RETURNING "confirmation_calls" AS "confirmationCall"
    `);
    return reserved[0]?.confirmationCall ?? null;
  }

  private async releaseConfirmationCall(eventId: string, confirmationCall: number) {
    const released = await this.prisma.$queryRaw<Array<{ confirmationCall: number }>>(Prisma.sql`
      UPDATE "didi_order_webhook_event"
      SET
        "confirmation_calls" = GREATEST("accepted_count", "confirmation_calls" - 1),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${eventId}::uuid
        AND "status" = 'processing'::"DidiOrderWebhookStatus"
        AND "confirmation_calls" = ${confirmationCall}
        AND "confirmation_calls" > "accepted_count"
      RETURNING "confirmation_calls" AS "confirmationCall"
    `);
    if (released.length !== 1) {
      throw new Error('Order webhook confirmation reservation could not be released safely');
    }
  }

  private async confirmReservedOrder(
    eventId: string,
    authToken: string,
    orderId: string,
    signal: AbortSignal,
  ) {
    const confirmationCall = await this.reserveConfirmationCall(eventId);
    if (confirmationCall === null) {
      throw new Error('Order webhook confirmation call budget is exhausted');
    }
    try {
      return await this.confirmOrder(authToken, orderId, signal);
    } catch (error) {
      // A structured non-zero errno proves that DiDi rejected the request. It
      // is the only failure for which reusing the slot cannot exceed two
      // possible provider-side acceptances. Timeout, network, 5xx and invalid
      // JSON stay reserved because the remote outcome is unknowable.
      if (isExplicitSafeDidiOrderRejection(error)) {
        await this.releaseConfirmationCall(eventId, confirmationCall);
      }
      throw error;
    }
  }

  private async acceptEventAndCompleteRequest(
    event: ClaimedEvent,
    confirmed: ConfirmResult,
    requestId: string,
    requestStartedAt: number,
    requestData: Prisma.DidiOrderWebhookRequestUncheckedUpdateInput,
  ) {
    await this.prisma.$transaction(async transaction => {
      await this.markEventAccepted(event, confirmed, transaction);
      await this.completeRequest(requestId, requestStartedAt, requestData, transaction);
    });
  }

  private async waitForAutomaticSecondAcceptance(deadlineAt: number) {
    const waitMs = DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS + 25;
    const requiredRemainingMs = waitMs
      + DIDI_ORDER_CONFIRM_RESERVE_MS
      + DIDI_ORDER_FINAL_AUDIT_RESERVE_MS;
    if (deadlineAt - Date.now() < requiredRemainingMs) return false;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return true;
  }

  private async tryAutomaticSecondConfirmation(args: {
    event: ClaimedEvent;
    candidate: ShopAcceptanceCandidate;
    authToken: string;
    orderId: string;
    sourceTimestamp: string;
    requestId: string;
    requestStartedAt: number;
    acceptedRequest: Prisma.DidiOrderWebhookRequestUncheckedUpdateInput;
    acceptanceDeadlineAt: number;
  }) {
    if (args.event.acceptedCount !== 1 || args.event.confirmationCalls >= 2) return;
    let second: ClaimedEvent | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!await this.waitForAutomaticSecondAcceptance(args.acceptanceDeadlineAt)) return;
      second = await this.claimSecondAcceptance(
        args.event.id,
        args.candidate.localShopId,
        args.candidate.didiShopId,
        args.candidate.appShopId,
        args.candidate.remoteShopValidated,
        args.candidate.shopResolutionSource,
        args.sourceTimestamp,
      );
      if (!second) return;

      const controller = new AbortController();
      timeout = setTimeout(
        () => controller.abort(),
        getRemainingDidiOrderTimeoutMs(
          args.acceptanceDeadlineAt - DIDI_ORDER_FINAL_AUDIT_RESERVE_MS,
          DIDI_ORDER_CONFIRM_TIMEOUT_MS,
        ),
      );
      const confirmed = await this.confirmReservedOrder(
        second.id,
        args.authToken,
        args.orderId,
        controller.signal,
      );
      await this.acceptEventAndCompleteRequest(
        second,
        confirmed,
        args.requestId,
        args.requestStartedAt,
        args.acceptedRequest,
      );
    } catch (error) {
      const remoteError = error instanceof DidiOrderConfirmError ? error : null;
      if (second) {
        try {
          await this.markEventAttemptFailed(
            second,
            remoteError,
            safeError(error, [args.authToken]),
          );
        } catch {
          // The first acceptance is already durable. A failed audit restoration
          // must not turn the successfully accepted webhook response into a 5xx.
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async findResolvedDuplicate(
    applicationId: string,
    payload: DidiOrderWebhookPayload,
    acceptanceDeadlineAt: number,
  ) {
    const existing = await this.prisma.didiOrderWebhookEvent.findUnique({
      where: {
        applicationId_orderId_type: {
          applicationId,
          orderId: payload.orderId,
          type: payload.type,
        },
      },
      select: {
        id: true,
        status: true,
        appShopId: true,
        didiShopId: true,
        remoteShopValidated: true,
        shopResolutionSource: true,
        startedAt: true,
        acceptedAt: true,
        failedAt: true,
        acceptedCount: true,
        confirmationCalls: true,
        shop: { select: { shopId: true } },
      },
    });
    if (!existing) return null;
    const existingDidiShopId = existing.didiShopId ?? existing.shop?.shopId ?? null;
    if (payload.shopId && existingDidiShopId !== payload.shopId) {
      throw new BadRequestException('order_id was previously received for another shop_id');
    }
    if (
      payload.appShopId
      && existing.appShopId !== payload.appShopId
      && !payload.shopId
    ) {
      throw new BadRequestException('order_id was previously received for another app_shop_id');
    }
    const effectiveConfirmationCalls = Math.max(
      existing.confirmationCalls,
      existing.acceptedCount,
    );
    if (existing.status === 'failed' && effectiveConfirmationCalls < 2) {
      // Failed pre-POST attempts and explicit provider rejections have no
      // outstanding confirmation reservation and may retry immediately. An
      // ambiguous POST keeps its reservation, so hold this redelivery open for
      // only the remaining separation interval before it competes for slot 2.
      if (effectiveConfirmationCalls > existing.acceptedCount) {
        if (!existing.failedAt) {
          throw new BadGatewayException(
            'Ambiguous DiDi confirmation is missing its retry timestamp',
          );
        }
        await this.waitForAmbiguousRetryBarrier(
          existing.failedAt,
          acceptanceDeadlineAt,
        );
      }
      return null;
    }
    // A failed event with both possible confirmation slots consumed is final.
    const failedConfirmationBudgetExhausted = existing.status === 'failed';
    if (!payload.shopId && !failedConfirmationBudgetExhausted) return null;
    if (
      existing.status === 'accepted'
      && existing.acceptedCount === 1
      && Math.max(existing.confirmationCalls, existing.acceptedCount) < 2
      && existing.acceptedAt
      && existing.acceptedAt.getTime()
        <= Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS
    ) {
      return null;
    }
    if (
      existing.status === 'processing'
      && existing.startedAt.getTime() <= Date.now() - DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS
    ) {
      return null;
    }
    return {
      id: existing.id,
      status: existing.status,
      appShopId: existing.appShopId,
      didiShopId: existingDidiShopId,
      remoteShopValidated: existing.remoteShopValidated,
      // During the zero-downtime migration window the previous writer can
      // persist remote_shop_validated=true while relying on the new column's
      // `local` default. Treat that legacy combination as remote evidence.
      shopResolutionSource: normalizeLegacyResolutionSource(
        existing.shopResolutionSource,
        existing.remoteShopValidated,
      ),
      acceptedCount: existing.acceptedCount,
      confirmationCalls: existing.confirmationCalls,
    };
  }

  private async waitForAmbiguousRetryBarrier(
    failedAt: Date,
    acceptanceDeadlineAt: number,
  ) {
    const waitMs = failedAt.getTime()
      + DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS
      - Date.now();
    if (waitMs <= 0) return;
    if (waitMs > DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS + 1_000) {
      throw new BadGatewayException('Ambiguous DiDi confirmation retry timestamp is invalid');
    }
    const boundedWaitMs = waitMs + 25;
    if (
      Date.now() + boundedWaitMs
      >= acceptanceDeadlineAt - DIDI_ORDER_FINAL_AUDIT_RESERVE_MS
    ) {
      throw new BadGatewayException('DiDi confirmation retry window exceeded');
    }
    await new Promise(resolve => setTimeout(resolve, boundedWaitMs));
  }

  private async resolveInitialShopCandidate(
    applicationId: string,
    appId: string,
    applicationSecret: () => string,
    payload: DidiOrderWebhookPayload,
    deadlineAt: number,
  ): Promise<ShopAcceptanceCandidate> {
    const localCandidates = payload.appShopId || payload.shopId
      ? await this.prisma.shop.findMany({
        where: {
          deletedAt: null,
          brand: { applicationId, deletedAt: null },
          OR: [
            ...(payload.shopId ? [{ shopId: payload.shopId }] : []),
            ...(payload.appShopId ? [{ appShopId: payload.appShopId }] : []),
          ],
        },
        select: { id: true, shopId: true, appShopId: true },
        take: 3,
      })
      : [];
    const exactLocalMatches = localCandidates.filter(candidate =>
      (!payload.shopId || candidate.shopId === payload.shopId)
      && (!payload.appShopId || candidate.appShopId === payload.appShopId));
    const localPairConflict = localCandidates.length > 0
      && (localCandidates.length !== 1 || exactLocalMatches.length !== 1);
    if (!localPairConflict && exactLocalMatches.length === 1) {
      const local = exactLocalMatches[0];
      return {
        appShopId: local.appShopId,
        didiShopId: local.shopId,
        localShopId: local.id,
        remoteShopValidated: false,
        shopResolutionSource: DidiOrderWebhookShopResolutionSource.local,
      };
    }
    if (!payload.shopId) {
      throw new BadRequestException(
        'Webhook shop must resolve to exactly one active shop for the webhook application',
      );
    }

    const inventoryResolution = await this.resolveInventoryAppShopId(
      applicationId,
      payload.shopId,
      payload.appShopId,
    );
    const mappingConflict = localPairConflict || inventoryResolution.conflict;
    if (inventoryResolution.appShopId) {
      return this.buildMappedShopCandidate(
        applicationId,
        payload.shopId,
        inventoryResolution.appShopId,
        DidiOrderWebhookShopResolutionSource.inventory,
      );
    }

    const remoteAppShopId = await this.resolveRemoteAppShopId(
      applicationId,
      appId,
      applicationSecret(),
      payload.shopId,
      mappingConflict,
      deadlineAt,
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
    return this.buildMappedShopCandidate(
      applicationId,
      payload.shopId,
      requiredAppShopId(remoteAppShopId, 'Resolved app_shop_id'),
      DidiOrderWebhookShopResolutionSource.remote,
    );
  }

  private async resolvePayloadShopCandidate(
    applicationId: string,
    didiShopId: string,
    appShopId: string,
  ): Promise<ShopAcceptanceCandidate> {
    const localMatches = await this.prisma.shop.findMany({
      where: {
        shopId: didiShopId,
        appShopId,
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
      },
      select: { id: true, shopId: true, appShopId: true },
      take: 2,
    });
    if (localMatches.length > 1) {
      throw new BadRequestException(
        'Webhook shop maps to more than one active local shop for the application',
      );
    }
    return {
      // The external identifiers used for authentication and confirmation
      // always remain the exact values received in the orderNew payload.
      appShopId,
      didiShopId,
      localShopId: localMatches[0]?.id ?? null,
      remoteShopValidated: false,
      shopResolutionSource: localMatches.length === 1
        ? DidiOrderWebhookShopResolutionSource.local
        : DidiOrderWebhookShopResolutionSource.payload,
    };
  }

  private async resolveLocalAlternativeShopCandidate(
    applicationId: string,
    shopId: string,
    excludedAppShopIds: ReadonlySet<string>,
  ): Promise<ShopAcceptanceCandidate | null> {
    const localCandidates = await this.prisma.shop.findMany({
      where: {
        shopId,
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
      },
      select: { id: true, shopId: true, appShopId: true },
      take: 2,
    });
    if (
      localCandidates.length === 1
      && !excludedAppShopIds.has(localCandidates[0].appShopId)
    ) {
      return {
        appShopId: localCandidates[0].appShopId,
        didiShopId: shopId,
        localShopId: localCandidates[0].id,
        remoteShopValidated: false,
        shopResolutionSource: DidiOrderWebhookShopResolutionSource.local,
      };
    }
    return null;
  }

  private async resolveInventoryAlternativeShopCandidate(
    applicationId: string,
    shopId: string,
    excludedAppShopIds: ReadonlySet<string>,
  ): Promise<ShopAcceptanceCandidate | null> {
    const inventoryResolution = await this.resolveInventoryAppShopId(applicationId, shopId);
    if (
      inventoryResolution.appShopId
      && !excludedAppShopIds.has(inventoryResolution.appShopId)
    ) {
      return {
        appShopId: inventoryResolution.appShopId,
        didiShopId: shopId,
        localShopId: null,
        remoteShopValidated: true,
        shopResolutionSource: DidiOrderWebhookShopResolutionSource.inventory,
      };
    }
    return null;
  }

  private async resolveRemoteAlternativeShopCandidate(
    applicationId: string,
    appId: string,
    applicationSecret: () => string,
    shopId: string,
    excludedAppShopIds: ReadonlySet<string>,
    deadlineAt: number,
  ): Promise<ShopAcceptanceCandidate | null> {
    const remoteAppShopId = await this.resolveRemoteAppShopId(
      applicationId,
      appId,
      applicationSecret(),
      shopId,
      true,
      deadlineAt,
    );
    if (!remoteAppShopId || excludedAppShopIds.has(remoteAppShopId)) return null;
    return {
      appShopId: requiredAppShopId(remoteAppShopId, 'Resolved app_shop_id'),
      didiShopId: shopId,
      localShopId: null,
      remoteShopValidated: true,
      shopResolutionSource: DidiOrderWebhookShopResolutionSource.remote,
    };
  }

  private async buildMappedShopCandidate(
    applicationId: string,
    didiShopId: string,
    appShopId: string,
    shopResolutionSource: DidiOrderWebhookShopResolutionSource,
  ): Promise<ShopAcceptanceCandidate> {
    const localMatches = await this.prisma.shop.findMany({
      where: {
        shopId: didiShopId,
        appShopId,
        deletedAt: null,
        brand: { applicationId, deletedAt: null },
      },
      select: { id: true, shopId: true, appShopId: true },
      take: 2,
    });
    if (localMatches.length > 1) {
      throw new BadRequestException(
        'Webhook shop maps to more than one active local shop for the application',
      );
    }
    return {
      appShopId,
      didiShopId,
      localShopId: localMatches[0]?.id ?? null,
      remoteShopValidated: true,
      shopResolutionSource,
    };
  }

  private async resolveInventoryAppShopId(
    applicationId: string,
    shopId: string,
    payloadAppShopId?: string,
  ): Promise<{ appShopId?: string; conflict: boolean }> {
    const candidates = await this.prisma.applicationShopInventoryShop.findMany({
      where: {
        inventory: {
          applicationId,
          lastSuccessfulFetchAt: { not: null },
        },
        OR: [
          { shopId },
          ...(payloadAppShopId ? [{ appShopId: payloadAppShopId }] : []),
        ],
      },
      select: { shopId: true, appShopId: true },
      take: 2,
    });
    const exact = payloadAppShopId
      ? candidates.find(candidate => candidate.shopId === shopId
        && candidate.appShopId === payloadAppShopId)
      : undefined;
    if (exact) return { appShopId: exact.appShopId, conflict: false };
    if (!payloadAppShopId) {
      const appShopIds = [...new Set(
        candidates
          .filter(candidate => candidate.shopId === shopId)
          .map(candidate => candidate.appShopId),
      )];
      return appShopIds.length === 1
        ? { appShopId: appShopIds[0], conflict: false }
        : { conflict: appShopIds.length > 1 };
    }
    return { conflict: candidates.length > 0 };
  }

  private async resolveRemoteAppShopId(
    applicationId: string,
    appId: string,
    appSecret: string,
    shopId: string,
    forceRefresh = false,
    deadlineAt?: number,
  ) {
    const cacheKey = `${applicationId}:${shopId}`;
    const freshInFlightKey = `${cacheKey}:fresh`;
    const inFlightKey = forceRefresh ? freshInFlightKey : cacheKey;
    const now = Date.now();
    if (!forceRefresh) {
      const freshInFlight = this.remoteShopResolutionInFlight.get(freshInFlightKey);
      if (freshInFlight) return waitForDidiOrderDeadline(freshInFlight, deadlineAt);
    }
    const cached = this.remoteShopResolutionCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      if (deadlineAt !== undefined) {
        getRemainingDidiOrderTimeoutMs(deadlineAt, DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS);
      }
      return cached.appShopId;
    }
    if (cached) this.remoteShopResolutionCache.delete(cacheKey);

    const inFlight = this.remoteShopResolutionInFlight.get(inFlightKey);
    if (inFlight) return waitForDidiOrderDeadline(inFlight, deadlineAt);

    const cacheWriter = Symbol(cacheKey);
    this.remoteShopResolutionCacheWriters.set(cacheKey, cacheWriter);
    let resolution!: Promise<string | undefined>;
    resolution = (async () => {
      const signal = AbortSignal.timeout(
        deadlineAt === undefined
          ? DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS
          : getRemainingDidiOrderTimeoutMs(
            deadlineAt,
            DIDI_ORDER_SHOP_RESOLUTION_TIMEOUT_MS,
          ),
      );
      const remoteShops = await this.shopListCoordinator.withShopListRateLimit(
        applicationId,
        () => this.fetchRemoteShopIdMap(appId, appSecret, [shopId], {
          signal,
          maxPages: DIDI_ORDER_SHOP_RESOLUTION_MAX_PAGES,
          maxRateLimitRetries: DIDI_ORDER_SHOP_RESOLUTION_RATE_LIMIT_RETRIES,
        }),
        signal,
      );
      const appShopId = remoteShops.get(shopId);
      if (
        appShopId
        && this.remoteShopResolutionCacheWriters.get(cacheKey) === cacheWriter
      ) {
        this.pruneRemoteShopResolutionCache(now);
        this.remoteShopResolutionCache.delete(cacheKey);
        this.remoteShopResolutionCache.set(cacheKey, {
          appShopId,
          expiresAt: Date.now() + DIDI_ORDER_SHOP_RESOLUTION_CACHE_TTL_MS,
        });
      }
      return appShopId;
    })().finally(() => {
      if (this.remoteShopResolutionInFlight.get(inFlightKey) === resolution) {
        this.remoteShopResolutionInFlight.delete(inFlightKey);
      }
      if (this.remoteShopResolutionCacheWriters.get(cacheKey) === cacheWriter) {
        this.remoteShopResolutionCacheWriters.delete(cacheKey);
      }
    });
    this.remoteShopResolutionInFlight.set(inFlightKey, resolution);
    return waitForDidiOrderDeadline(resolution, deadlineAt);
  }

  private pruneRemoteShopResolutionCache(now: number) {
    for (const [key, value] of this.remoteShopResolutionCache) {
      if (value.expiresAt <= now) this.remoteShopResolutionCache.delete(key);
    }
    while (this.remoteShopResolutionCache.size >= DIDI_ORDER_SHOP_RESOLUTION_CACHE_MAX_ENTRIES) {
      const oldestKey = this.remoteShopResolutionCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.remoteShopResolutionCache.delete(oldestKey);
    }
  }

  private async claimEvent(
    applicationId: string,
    shopId: string | null,
    didiShopId: string,
    remoteShopValidated: boolean,
    shopResolutionSource: DidiOrderWebhookShopResolutionSource,
    payload: DidiOrderWebhookPayload & { appShopId: string },
    financials: DidiOrderFinancialSnapshot,
  ): Promise<ClaimedEvent> {
    try {
      const created = await this.prisma.didiOrderWebhookEvent.create({
        data: {
          applicationId,
          shopId,
          didiShopId,
          appShopId: payload.appShopId,
          orderId: payload.orderId,
          type: payload.type,
          sourceTimestamp: payload.sourceTimestamp,
          remoteShopValidated,
          shopResolutionSource,
          orderPriceMinor: payload.orderPriceMinor,
          realPriceMinor: payload.realPriceMinor,
          realPayPriceMinor: payload.realPayPriceMinor,
          orderCurrency: financials.orderCurrency,
          profitMode: financials.profitMode,
          profitValue: financials.profitValue,
          nativeToMxnRate: financials.nativeToMxnRate,
          mxnPerUsdRate: financials.mxnPerUsdRate,
          profitMxn: financials.profitMxn,
          profitUsd: financials.profitUsd,
        },
        select: {
          id: true,
          status: true,
          appShopId: true,
          didiShopId: true,
          acceptedCount: true,
          confirmationCalls: true,
          profitMxn: true,
        },
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
      select: {
        id: true,
        status: true,
        appShopId: true,
        didiShopId: true,
        acceptedCount: true,
        confirmationCalls: true,
        profitMxn: true,
        startedAt: true,
        acceptedAt: true,
        failedAt: true,
        shop: { select: { shopId: true } },
      },
    });
    if (!existing) throw new Error('Idempotency record disappeared after unique conflict');
    const existingDidiShopId = existing.didiShopId ?? existing.shop?.shopId;
    if (!existingDidiShopId) {
      throw new Error('Idempotency record has no verifiable shop mapping');
    }
    if (existingDidiShopId !== didiShopId) {
      throw new BadRequestException('order_id was previously received for another shop_id');
    }
    if (existing.appShopId !== payload.appShopId && !payload.shopId) {
      throw new BadRequestException('order_id was previously received for another app_shop_id');
    }
    if (
      existing.acceptedCount >= 2
      || Math.max(existing.confirmationCalls, existing.acceptedCount) >= 2
    ) return { ...existing, claimed: false };

    if (existing.status === 'accepted') {
      const secondAcceptance = await this.claimSecondAcceptance(
        existing.id,
        shopId,
        didiShopId,
        payload.appShopId,
        remoteShopValidated,
        shopResolutionSource,
        payload.sourceTimestamp,
      );
      if (secondAcceptance) return secondAcceptance;
    } else {
      const staleBefore = new Date(Date.now() - DIDI_ORDER_WEBHOOK_STALE_PROCESSING_MS);
      const ambiguousRetryBefore = new Date(
        Date.now() - DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS,
      );
      const reclaimableWhere = existing.status === 'failed'
        ? {
            id: existing.id,
            status: 'failed' as const,
            acceptedCount: existing.acceptedCount,
            confirmationCalls: existing.confirmationCalls,
            ...(existing.confirmationCalls > existing.acceptedCount
              ? { failedAt: { lte: ambiguousRetryBefore } }
              : {}),
          }
        : {
            id: existing.id,
            status: 'processing' as const,
            acceptedCount: { lt: 2 },
            confirmationCalls: { lt: 2 },
            startedAt: { lt: staleBefore },
          };
      const reclaimed = await this.prisma.didiOrderWebhookEvent.updateMany({
        where: reclaimableWhere,
        data: {
          status: 'processing',
          attempts: { increment: 1 },
          shopId,
          didiShopId,
          appShopId: payload.appShopId,
          remoteShopValidated,
          shopResolutionSource,
          sourceTimestamp: payload.sourceTimestamp,
          ...(existing.acceptedCount === 0
            ? {
                orderPriceMinor: payload.orderPriceMinor,
                realPriceMinor: payload.realPriceMinor,
                realPayPriceMinor: payload.realPayPriceMinor,
                orderCurrency: financials.orderCurrency,
                profitMode: financials.profitMode,
                profitValue: financials.profitValue,
                nativeToMxnRate: financials.nativeToMxnRate,
                mxnPerUsdRate: financials.mxnPerUsdRate,
                profitMxn: financials.profitMxn,
                profitUsd: financials.profitUsd,
              }
            : {}),
          startedAt: new Date(),
          ...(existing.acceptedCount === 0 ? { acceptedAt: null } : {}),
          failedAt: null,
          remoteHttpStatus: null,
          remoteErrno: null,
          remoteErrmsg: null,
          errorMessage: null,
        },
      });
      if (reclaimed.count === 1) {
        return {
          id: existing.id,
          status: 'processing',
          appShopId: payload.appShopId,
          didiShopId,
          acceptedCount: existing.acceptedCount,
          confirmationCalls: existing.confirmationCalls,
          profitMxn: existing.acceptedCount === 0
            ? financials.profitMxn
            : existing.profitMxn,
          claimed: true,
        };
      }
    }

    existing = await this.prisma.didiOrderWebhookEvent.findUnique({
      where,
      select: {
        id: true,
        status: true,
        appShopId: true,
        didiShopId: true,
        acceptedCount: true,
        confirmationCalls: true,
        profitMxn: true,
        startedAt: true,
        acceptedAt: true,
        failedAt: true,
        shop: { select: { shopId: true } },
      },
    });
    if (!existing) throw new Error('Idempotency record disappeared while claiming');
    return { ...existing, claimed: false };
  }

  private async claimSecondAcceptance(
    eventId: string,
    shopId: string | null,
    didiShopId: string,
    appShopId: string,
    remoteShopValidated: boolean,
    shopResolutionSource: DidiOrderWebhookShopResolutionSource,
    sourceTimestamp: string,
  ): Promise<ClaimedEvent | null> {
    const claimed = await this.prisma.$queryRaw<Array<{
      id: string;
      status: 'processing';
      appShopId: string;
      didiShopId: string | null;
      acceptedCount: number;
      confirmationCalls: number;
      profitMxn: Prisma.Decimal | null;
    }>>(Prisma.sql`
      UPDATE "didi_order_webhook_event"
      SET
        "status" = 'processing'::"DidiOrderWebhookStatus",
        "attempts" = "attempts" + 1,
        "shop_id" = ${shopId}::uuid,
        "didi_shop_id" = ${didiShopId},
        "app_shop_id" = ${appShopId},
        "remote_shop_validated" = ${remoteShopValidated},
        "shop_resolution_source" = ${shopResolutionSource}::"DidiOrderWebhookShopResolutionSource",
        "source_timestamp" = ${sourceTimestamp},
        "started_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${eventId}::uuid
        AND "status" = 'accepted'::"DidiOrderWebhookStatus"
        AND "accepted_count" = 1
        AND GREATEST("confirmation_calls", "accepted_count") < 2
        AND "accepted_at" IS NOT NULL
        AND "accepted_at" <= CURRENT_TIMESTAMP
          - (${DIDI_ORDER_WEBHOOK_SECOND_ACCEPTANCE_DELAY_MS} * INTERVAL '1 millisecond')
      RETURNING
        "id",
        "status",
        "app_shop_id" AS "appShopId",
        "didi_shop_id" AS "didiShopId",
        "accepted_count" AS "acceptedCount",
        "confirmation_calls" AS "confirmationCalls",
        "profit_mxn" AS "profitMxn"
    `);
    return claimed[0] ? { ...claimed[0], claimed: true } : null;
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

function optionalMoneyMinor(value: unknown, _label: string): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
  if (!/^\d{1,19}$/.test(normalized)) {
    return null;
  }
  const parsed = BigInt(normalized);
  if (parsed > 9_223_372_036_854_775_807n) {
    return null;
  }
  return parsed;
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

function normalizeLegacyResolutionSource(
  source: DidiOrderWebhookShopResolutionSource,
  remoteShopValidated: boolean,
) {
  return remoteShopValidated && source === DidiOrderWebhookShopResolutionSource.local
    ? DidiOrderWebhookShopResolutionSource.remote
    : source;
}

function isExplicitSafeDidiOrderRejection(
  error: unknown,
): error is DidiOrderConfirmError {
  return error instanceof DidiOrderConfirmError
    && error.httpStatus !== null
    && error.httpStatus < 500
    && error.errno !== null
    && error.errno !== 0;
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
