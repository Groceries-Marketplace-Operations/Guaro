import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DidiOrderWebhookShopResolutionSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CentralOrderWebhookEventsQueryDto } from './dto/central-order-webhook-events-query.dto';
import { OrderWebhookEventsQueryDto } from './dto/order-webhook-events-query.dto';
import {
  decimalString,
  minorUnitsToMajorString,
} from './didi-order-webhook-finance.util';

const REQUEST_SELECT = {
  id: true,
  applicationId: true,
  eventId: true,
  appShopId: true,
  didiShopId: true,
  orderId: true,
  type: true,
  stage: true,
  outcome: true,
  shopResolutionSource: true,
  profitRecognized: true,
  remoteShopValidated: true,
  localHttpStatus: true,
  durationMs: true,
  remoteHttpStatus: true,
  remoteErrno: true,
  remoteErrmsg: true,
  errorMessage: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  application: {
    select: {
      id: true,
      appId: true,
      appName: true,
      country: true,
    },
  },
  event: {
    select: {
      shopId: true,
      didiShopId: true,
      status: true,
      attempts: true,
      acceptedCount: true,
      confirmationCalls: true,
      shopResolutionSource: true,
      remoteShopValidated: true,
      orderPriceMinor: true,
      realPriceMinor: true,
      realPayPriceMinor: true,
      orderCurrency: true,
      profitMode: true,
      profitValue: true,
      nativeToMxnRate: true,
      mxnPerUsdRate: true,
      profitMxn: true,
      profitUsd: true,
      sourceTimestamp: true,
      startedAt: true,
      acceptedAt: true,
      failedAt: true,
      shop: {
        select: {
          id: true,
          shopId: true,
          name: true,
          brand: { select: { id: true, brandId: true, brandName: true } },
        },
      },
    },
  },
} satisfies Prisma.DidiOrderWebhookRequestSelect;

type SafeRequest = Prisma.DidiOrderWebhookRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

@Injectable()
export class DidiOrderWebhookEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(applicationId: string, query: OrderWebhookEventsQueryDto) {
    const application = await this.findApplication(applicationId);
    const result = await this.findMany(applicationId, query);

    return {
      ...result,
      application: { id: application.id, appName: application.appName },
    };
  }

  async findAllGlobal(query: CentralOrderWebhookEventsQueryDto) {
    const { applicationId, ...filters } = query;
    if (applicationId) await this.findApplication(applicationId);
    return this.findMany(applicationId, filters);
  }

  private async findMany(
    applicationId: string | undefined,
    query: OrderWebhookEventsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where = this.requestWhere(applicationId, query);
    const summaryWhere = this.requestWhere(applicationId, { ...query, status: undefined });

    const [requests, summaryGroups] = await Promise.all([
      this.prisma.didiOrderWebhookRequest.findMany({
        where,
        select: REQUEST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.didiOrderWebhookRequest.groupBy({
        by: ['outcome'],
        where: summaryWhere,
        _count: { _all: true },
      }),
    ]);

    const summaryByOutcome = Object.fromEntries(
      summaryGroups.map(group => [group.outcome, group._count._all]),
    );
    const summary = {
      total: summaryGroups.reduce((sum, group) => sum + group._count._all, 0),
      accepted: summaryByOutcome.accepted ?? 0,
      deduplicated: summaryByOutcome.deduplicated ?? 0,
      rejected: summaryByOutcome.rejected ?? 0,
      failed: summaryByOutcome.failed ?? 0,
      processing: summaryByOutcome.processing ?? 0,
    };
    const total = query.status ? (summaryByOutcome[query.status] ?? 0) : summary.total;

    return {
      data: requests.map(request => this.toResponse(request)),
      total,
      page,
      limit,
      summary,
    };
  }

  async findOne(applicationId: string, requestId: string) {
    const application = await this.findApplication(applicationId);
    const request = await this.prisma.didiOrderWebhookRequest.findFirst({
      where: { id: requestId, applicationId },
      select: REQUEST_SELECT,
    });
    if (!request) throw new NotFoundException('Order webhook request log not found');
    return {
      ...this.toResponse(request),
      application: { id: application.id, appName: application.appName },
    };
  }

  async findOneGlobal(requestId: string) {
    const request = await this.prisma.didiOrderWebhookRequest.findFirst({
      where: { id: requestId },
      select: REQUEST_SELECT,
    });
    if (!request) throw new NotFoundException('Order webhook request log not found');
    return this.toResponse(request);
  }

  private async findApplication(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, appName: true },
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  private requestWhere(
    applicationId: string | undefined,
    query: OrderWebhookEventsQueryDto,
  ): Prisma.DidiOrderWebhookRequestWhereInput {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    const minOrderMinor = query.minOrderAmount
      ? decimalAmountToMinorUnits(query.minOrderAmount)
      : undefined;
    const maxOrderMinor = query.maxOrderAmount
      ? decimalAmountToMinorUnits(query.maxOrderAmount)
      : undefined;
    if (minOrderMinor !== undefined && maxOrderMinor !== undefined && minOrderMinor > maxOrderMinor) {
      throw new BadRequestException('minOrderAmount must be less than or equal to maxOrderAmount');
    }
    const minProfitMxn = query.minProfitMxn ? new Prisma.Decimal(query.minProfitMxn) : undefined;
    const maxProfitMxn = query.maxProfitMxn ? new Prisma.Decimal(query.maxProfitMxn) : undefined;
    const profitRangeRequested = minProfitMxn !== undefined || maxProfitMxn !== undefined;
    if (minProfitMxn && maxProfitMxn && minProfitMxn.gt(maxProfitMxn)) {
      throw new BadRequestException('minProfitMxn must be less than or equal to maxProfitMxn');
    }
    if (query.hasProfit === false && profitRangeRequested) {
      throw new BadRequestException('Profit ranges require hasProfit=true or no hasProfit filter');
    }
    if (
      query.minDurationMs !== undefined
      && query.maxDurationMs !== undefined
      && query.minDurationMs > query.maxDurationMs
    ) {
      throw new BadRequestException('minDurationMs must be less than or equal to maxDurationMs');
    }

    const amountField = {
      order_price: 'orderPriceMinor',
      real_price: 'realPriceMinor',
      real_pay_price: 'realPayPriceMinor',
    }[query.amountField ?? 'real_pay_price'] as
      'orderPriceMinor' | 'realPriceMinor' | 'realPayPriceMinor';
    const profitRange = {
      ...(minProfitMxn ? { gte: minProfitMxn } : {}),
      ...(maxProfitMxn ? { lte: maxProfitMxn } : {}),
      ...(query.hasProfit === true ? { not: null } : {}),
    };
    const eventFilter: Prisma.DidiOrderWebhookEventWhereInput = {
      ...(minOrderMinor !== undefined || maxOrderMinor !== undefined
        ? {
            [amountField]: {
              ...(minOrderMinor !== undefined ? { gte: minOrderMinor } : {}),
              ...(maxOrderMinor !== undefined ? { lte: maxOrderMinor } : {}),
            },
          }
        : {}),
      ...(Object.keys(profitRange).length > 0 ? { profitMxn: profitRange } : {}),
    };
    const q = query.q?.trim();
    const qIsNumericId = q ? /^\d{3,20}$/.test(q) : false;

    return {
      ...(applicationId ? { applicationId } : {}),
      ...(query.status ? { outcome: query.status } : {}),
      ...(query.appShopId?.trim() ? { appShopId: query.appShopId.trim() } : {}),
      ...(query.didiShopId ? { didiShopId: query.didiShopId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.hasProfit === false
        ? { profitRecognized: false }
        : query.hasProfit === true || profitRangeRequested
          ? { profitRecognized: true }
          : {}),
      ...(query.country ? { application: { country: query.country } } : {}),
      ...(query.minDurationMs !== undefined || query.maxDurationMs !== undefined
        ? {
            durationMs: {
              ...(query.minDurationMs !== undefined ? { gte: query.minDurationMs } : {}),
              ...(query.maxDurationMs !== undefined ? { lte: query.maxDurationMs } : {}),
            },
          }
        : {}),
      ...(Object.keys(eventFilter).length > 0 ? { event: { is: eventFilter } } : {}),
      ...(q
        ? {
            OR: qIsNumericId
              ? [
                  { orderId: q },
                  { appShopId: q },
                  { didiShopId: q },
                  { application: { appId: { startsWith: q } } },
                ]
              : [
                  { application: { appName: { contains: q, mode: 'insensitive' } } },
                  { application: { appId: { startsWith: q, mode: 'insensitive' } } },
                ],
          }
        : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
  }

  private toResponse(request: SafeRequest) {
    const event = request.event;
    const storedResolutionSource = request.shopResolutionSource
      ?? event?.shopResolutionSource
      ?? null;
    const remoteShopValidated = request.shopResolutionSource !== null
      ? request.remoteShopValidated
      : (event?.remoteShopValidated ?? request.remoteShopValidated);
    const shopResolutionSource = remoteShopValidated
      && storedResolutionSource === DidiOrderWebhookShopResolutionSource.local
      ? DidiOrderWebhookShopResolutionSource.remote
      : storedResolutionSource;
    return {
      id: request.id,
      applicationId: request.applicationId,
      application: request.application,
      eventId: request.eventId,
      shopId: event?.shopId ?? null,
      didiShopId: request.didiShopId ?? event?.didiShopId ?? null,
      appShopId: request.appShopId,
      orderId: request.orderId,
      type: request.type,
      // Keep status as an alias for clients created before request-level
      // outcomes were added. New UI code uses outcome.
      status: request.outcome,
      stage: request.stage,
      outcome: request.outcome,
      shopResolutionSource,
      remoteShopValidated,
      localHttpStatus: request.localHttpStatus,
      durationMs: request.durationMs,
      attempts: event?.attempts ?? null,
      acceptedCount: event?.acceptedCount ?? null,
      confirmationCalls: event?.confirmationCalls ?? null,
      sourceTimestamp: event?.sourceTimestamp ?? null,
      sourceOccurredAt: unixTimestampToIso(event?.sourceTimestamp ?? null),
      remoteHttpStatus: request.remoteHttpStatus,
      remoteErrno: request.remoteErrno,
      remoteErrmsg: sanitizeDisplayText(request.remoteErrmsg),
      errorMessage: sanitizeDisplayText(request.errorMessage),
      startedAt: event?.startedAt ?? request.createdAt,
      acceptedAt: event?.acceptedAt ?? null,
      failedAt: event?.failedAt ?? null,
      completedAt: request.completedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      orderPriceMinor: event?.orderPriceMinor?.toString() ?? null,
      orderPrice: minorUnitsToMajorString(event?.orderPriceMinor),
      realPriceMinor: event?.realPriceMinor?.toString() ?? null,
      realPrice: minorUnitsToMajorString(event?.realPriceMinor),
      realPayPriceMinor: event?.realPayPriceMinor?.toString() ?? null,
      realPayPrice: minorUnitsToMajorString(event?.realPayPriceMinor),
      orderCurrency: event?.orderCurrency?.trim() ?? null,
      profitMode: event?.profitMode ?? null,
      profitValue: decimalString(event?.profitValue),
      nativeToMxnRate: decimalString(event?.nativeToMxnRate),
      mxnPerUsdRate: decimalString(event?.mxnPerUsdRate),
      profitMxn: decimalString(event?.profitMxn),
      profitUsd: decimalString(event?.profitUsd),
      profitRecognized: request.profitRecognized,
      shop: event?.shop
        ? {
            id: event.shop.id,
            shopId: event.shop.shopId,
            name: event.shop.name,
            brand: event.shop.brand,
          }
        : null,
    };
  }
}
export function decimalAmountToMinorUnits(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n) + BigInt(fraction.padEnd(2, '0'));
}

export function unixTimestampToIso(value: string | null) {
  if (!value || !/^\d{10,16}$/.test(value)) return null;
  const raw = BigInt(value);
  const milliseconds = value.length <= 10
    ? raw * 1000n
    : value.length <= 13
      ? raw
      : raw / (10n ** BigInt(value.length - 13));
  if (milliseconds > BigInt(8_640_000_000_000_000)) return null;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sanitizeDisplayText(value: string | null) {
  if (!value) return null;
  return value
    .replace(/((?:auth_token|app_secret|refresh_token|authorization)\s*[=:]\s*)[^\s,;}&]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,;}&]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 2000);
}
