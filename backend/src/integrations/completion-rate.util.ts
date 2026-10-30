import { BAD_CANCELLATIONS, FINISHED_STATUSES, OrderStatus } from '../didi-order-webhooks/order-status';

export function monitoringWindow(now: Date): Date | null {
  const end = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(end);
  const hour = Number(parts.find(p => p.type === 'hour')!.value);
  const minute = Number(parts.find(p => p.type === 'minute')!.value);
  return hour >= 6 || hour < 3 || (hour === 3 && minute === 0) ? end : null;
}

export function classifyOrder(order: { status: number; createdTime: Date | null; terminalTime: Date | null }): 'completed' | 'cancelled' | 'excluded' | 'unknown' {
  if (FINISHED_STATUSES.has(order.status)) return 'completed';
  if (BAD_CANCELLATIONS.has(order.status)) return 'cancelled';
  return order.status === OrderStatus.CANCEL ? 'unknown' : 'excluded';
}

export function evaluateRate(completed: number, cancelled: number, baseline: number, deviation: number, minimum: number) {
  const total = completed + cancelled;
  const cancelRate = total ? cancelled * 100 / total : null;
  return {
    total,
    completionRate: total < 4 || cancelRate === null ? null : Math.round((100 - cancelRate) * 100) / 100,
    alert: total >= Math.max(4, minimum) && cancelRate !== null && cancelRate - baseline >= deviation - 1e-9,
  };
}
