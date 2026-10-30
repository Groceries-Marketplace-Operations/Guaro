import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCancellationDetail } from './resolve-cancellation-detail';
import { CANCELLATION_STATUSES, FINISHED_STATUSES, ORDER_STATUSES, OrderStatus } from './order-status';

export { BAD_CANCELLATIONS } from './resolve-cancellation-detail';

export function isTerminal(status: number) {
  return FINISHED_STATUSES.has(status) || status === OrderStatus.CANCEL || CANCELLATION_STATUSES.has(status);
}
function timestamp(value: unknown): Date {
  if (!/^\d{1,10}$/.test(String(value))) throw new BadRequestException('Invalid order timestamp');
  const seconds = Number(value);
  if (seconds <= 0 || seconds > Date.now() / 1000 + 300) throw new BadRequestException('Invalid order timestamp');
  return new Date(seconds * 1000);
}
function id(value: unknown) {
  if (!/^\d{1,20}$/.test(String(value))) throw new BadRequestException('Invalid order identifier');
  return String(value);
}

export function parseLifecycle(root: Record<string, any>, appId: string) {
  if (!['orderNew', 'deliveryStatus', 'orderCancel'].includes(root.type)) throw new BadRequestException('Unsupported order event type');
  if (id(root.app_id) !== appId) throw new BadRequestException('Payload app_id does not match webhook application');
  const data = root.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BadRequestException('Invalid order data');
  const orderId = id(data.order_id);
  const eventTime = timestamp(root.timestamp);
  const info = root.type === 'orderNew' ? data.order_info : undefined;
  const status = root.type === 'orderNew' ? 100 : root.type === 'orderCancel' ? 170 : Number(data.delivery_status);
  if (!ORDER_STATUSES.has(status)) throw new BadRequestException('Invalid delivery_status');
  const appShopId = root.app_shop_id ?? info?.shop?.app_shop_id;
  if (appShopId != null && (typeof appShopId !== 'string' && typeof appShopId !== 'number' || !String(appShopId).trim() || String(appShopId).length > 200)) {
    throw new BadRequestException('Invalid app_shop_id');
  }
  return {
    orderId, status, eventTime,
    createdTime: info?.create_time ? timestamp(info.create_time) : root.type === 'orderNew' ? eventTime : null,
    appShopId: appShopId == null ? null : String(appShopId),
    didiShopId: info?.shop?.shop_id == null ? null : id(info.shop.shop_id),
    terminalTime: isTerminal(status) ? eventTime : null,
  };
}

@Injectable()
export class CompletionRateOrderService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async resolveAfterWebhook(application: { id: string; appId: string; appSecret: string }, root: Record<string, unknown>) {
    const data = root.data as Record<string, unknown>;
    const order = await this.prisma.completionRateOrder.findUnique({
      where: { applicationId_orderId: { applicationId: application.id, orderId: String(data.order_id) } },
    });
    if (!order || order.status !== OrderStatus.CANCEL) return false;
    const monitored = await this.prisma.brand.findFirst({ where: { applicationId: application.id, deletedAt: null,
      OR: [{ crAlertsEnabled: true }, { crAutoClosureEnabled: true }] }, select: { id: true } });
    if (!monitored) return false;
    return resolveCancellationDetail(this.prisma, this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY'), application, order);
  }

  async record(applicationId: string, appId: string, root: Record<string, unknown>) {
    const incoming = parseLifecycle(root, appId);
    // Serialize by application + order: duplicates and out-of-order webhooks
    // cannot regress a terminal status or create multiple counted orders.
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${applicationId + ':' + incoming.orderId}, 0))`;
      const key = { applicationId_orderId: { applicationId, orderId: incoming.orderId } };
      const previous = await tx.completionRateOrder.findUnique({ where: key });
      if (!previous) {
        await tx.completionRateOrder.create({ data: { applicationId, ...incoming } });
        return;
      }
      if (previous.appShopId && incoming.appShopId && previous.appShopId !== incoming.appShopId) {
        throw new BadRequestException('Order shop does not match previous event');
      }
      const advance = incoming.eventTime >= previous.eventTime
        && (!isTerminal(previous.status) || isTerminal(incoming.status))
        && !(previous.status !== 170 && isTerminal(previous.status) && incoming.status === 170);
      await tx.completionRateOrder.update({ where: key, data: {
        appShopId: previous.appShopId ?? incoming.appShopId,
        didiShopId: previous.didiShopId ?? incoming.didiShopId,
        createdTime: previous.createdTime ?? incoming.createdTime,
        ...(advance ? { status: incoming.status, eventTime: incoming.eventTime,
          terminalTime: previous.terminalTime ?? incoming.terminalTime } : {}),
      } });
    });
  }
}
