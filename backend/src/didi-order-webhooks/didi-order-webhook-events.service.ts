import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderWebhookEventsQueryDto } from './dto/order-webhook-events-query.dto';

const REQUEST_SELECT = {
  id: true,
  applicationId: true,
  eventId: true,
  appShopId: true,
  orderId: true,
  type: true,
  stage: true,
  outcome: true,
  localHttpStatus: true,
  durationMs: true,
  remoteHttpStatus: true,
  remoteErrno: true,
  remoteErrmsg: true,
  errorMessage: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  event: {
    select: {
      shopId: true,
      status: true,
      attempts: true,
      sourceTimestamp: true,
      startedAt: true,
      acceptedAt: true,
      failedAt: true,
      shop: {
        select: {
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
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where = this.requestWhere(applicationId, query);
    const summaryWhere = this.requestWhere(applicationId, { ...query, status: undefined });

    const [requests, total, all, accepted, deduplicated, rejected, failed, processing] =
      await Promise.all([
        this.prisma.didiOrderWebhookRequest.findMany({
          where,
          select: REQUEST_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.didiOrderWebhookRequest.count({ where }),
        this.prisma.didiOrderWebhookRequest.count({ where: summaryWhere }),
        this.prisma.didiOrderWebhookRequest.count({
          where: { ...summaryWhere, outcome: 'accepted' },
        }),
        this.prisma.didiOrderWebhookRequest.count({
          where: { ...summaryWhere, outcome: 'deduplicated' },
        }),
        this.prisma.didiOrderWebhookRequest.count({
          where: { ...summaryWhere, outcome: 'rejected' },
        }),
        this.prisma.didiOrderWebhookRequest.count({
          where: { ...summaryWhere, outcome: 'failed' },
        }),
        this.prisma.didiOrderWebhookRequest.count({
          where: { ...summaryWhere, outcome: 'processing' },
        }),
      ]);

    return {
      data: requests.map(request => this.toResponse(request)),
      total,
      page,
      limit,
      summary: { total: all, accepted, deduplicated, rejected, failed, processing },
      application: { id: application.id, appName: application.appName },
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

  private async findApplication(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, appName: true },
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  private requestWhere(
    applicationId: string,
    query: OrderWebhookEventsQueryDto,
  ): Prisma.DidiOrderWebhookRequestWhereInput {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }

    return {
      applicationId,
      ...(query.status ? { outcome: query.status } : {}),
      ...(query.appShopId?.trim() ? { appShopId: query.appShopId.trim() } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
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
    return {
      id: request.id,
      applicationId: request.applicationId,
      eventId: request.eventId,
      shopId: event?.shopId ?? null,
      appShopId: request.appShopId,
      orderId: request.orderId,
      type: request.type,
      // Keep status as an alias for clients created before request-level
      // outcomes were added. New UI code uses outcome.
      status: request.outcome,
      stage: request.stage,
      outcome: request.outcome,
      localHttpStatus: request.localHttpStatus,
      durationMs: request.durationMs,
      attempts: event?.attempts ?? null,
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
      shop: event
        ? {
            id: event.shopId,
            shopId: event.shop.shopId,
            name: event.shop.name,
            brand: event.shop.brand,
          }
        : null,
    };
  }
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
