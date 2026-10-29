import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const FINISHED = new Set([160, 600]);
export const BAD_CANCELLATIONS = new Set([902, 921, 922, 923, 961, 971, 981]);
const STATUSES = new Set([100, 120, 130, 140, 150, 160, 170, 180, 190, 200, 400, 500, 600, 901, ...BAD_CANCELLATIONS]);
export function isTerminal(status: number) {
  return FINISHED.has(status) || status === 170 || status === 901 || BAD_CANCELLATIONS.has(status);
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
  if (!STATUSES.has(status)) throw new BadRequestException('Invalid delivery_status');
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
  constructor(private readonly prisma: PrismaService) {}

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
