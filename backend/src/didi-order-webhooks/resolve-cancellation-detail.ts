import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { DIDI_BASE, getAuthToken, parseJsonKeepingIds } from '../queue/handlers/didi-food.util';

import { CANCELLATION_STATUSES, OrderStatus } from './order-status';
export { BAD_CANCELLATIONS } from './order-status';

type Application = { id: string; appId: string; appSecret: string };
type Order = { id: string; applicationId: string; orderId: string; appShopId: string | null; status: number };

export async function resolveCancellationDetail(prisma: PrismaService, encryptionKey: string, app: Application, order: Order): Promise<boolean> {
  if (order.applicationId !== app.id || order.status !== OrderStatus.CANCEL) return false;
  const local = order.appShopId ? null : await prisma.didiOrderWebhookEvent.findFirst({
    where: { applicationId: app.id, orderId: order.orderId, type: 'orderNew' }, select: { appShopId: true },
  });
  const appShopId = order.appShopId ?? local?.appShopId;
  if (!appShopId) return false;

  const signal = AbortSignal.timeout(15_000);
  const token = await getAuthToken(app.appId, decrypt(app.appSecret, encryptionKey), appShopId, signal);
  const url = new URL(`${DIDI_BASE}/v1/order/order/detail`);
  url.searchParams.set('auth_token', token);
  url.searchParams.set('order_id', order.orderId);
  const response = await fetch(url, { signal });
  const body = parseJsonKeepingIds(await response.text());
  const status = Number(body.data?.status);
  if (!response.ok || Number(body.errno) !== 0 || !CANCELLATION_STATUSES.has(status)) return false;

  const created = Number(body.data.create_time);
  const cancelled = Number(body.data.cancel_time);
  const updated = await prisma.completionRateOrder.updateMany({ where: { id: order.id, status: order.status }, data: {
    status, appShopId,
    ...(Number.isSafeInteger(created) && created > 0 ? { createdTime: new Date(created * 1000) } : {}),
    ...(Number.isSafeInteger(cancelled) && cancelled > 0 ? { terminalTime: new Date(cancelled * 1000) } : {}),
  } });
  return updated.count > 0;
}
