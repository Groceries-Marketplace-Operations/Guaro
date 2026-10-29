import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/crypto.util';
import { DIDI_BASE, getAuthToken, parseJsonKeepingIds } from '../queue/handlers/didi-food.util';
import { classifyOrder, monitoringWindow } from './completion-rate.util';
import { closureDestination, operationalDay, storeCrDecision } from './store-cr.util';

const readyApplication = { deletedAt: null, orderWebhookCreatedAt: { not: null }, orderWebhookTokenHash: { not: null }, orderWebhookDisabledAt: null };
type Order = { orderId: string; status: number; createdTime: Date | null; terminalTime: Date | null };
export function summarizeStoreOrders(orders: Order[]) {
  const result = { completed: 0, cancelled: 0, unknown: 0, orderIds: { completed: [] as string[], cancelled: [] as string[], unknown: [] as string[] } };
  for (const order of orders) {
    const category = classifyOrder(order);
    if (category === 'excluded') continue;
    result[category]++;
    result.orderIds[category].push(order.orderId);
  }
  return result;
}

@Injectable()
export class StoreCrService {
  private readonly logger = new Logger(StoreCrService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  destination() {
    return closureDestination(this.config.get<string>('DCHAT_URL'), this.config.get<string>('DCHAT_STORE_CLOSURE_GROUP_ID'));
  }

  async history(brandId: string) {
    const [decisions, closures] = await Promise.all([
      this.prisma.storeCrDecision.findMany({ where: { brandId }, orderBy: { windowEnd: 'desc' }, take: 100,
        include: { shop: { select: { name: true, appShopId: true } } } }),
      this.prisma.storeCrClosure.findMany({ where: { brandId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return { decisions, closures };
  }

  async evaluate(end: Date) {
    const brands = await this.prisma.brand.findMany({ where: { deletedAt: null, crAutoClosureEnabled: true, application: readyApplication },
      include: { shops: { where: { deletedAt: null }, select: { id: true, appShopId: true, shopId: true, name: true } } } });
    for (const brand of brands) {
      const day = operationalDay(brand.country, end);
      const existing = await this.prisma.storeCrDecision.findMany({ where: { brandId: brand.id, windowEnd: end }, select: { shopId: true } });
      const evaluated = new Set(existing.map(row => row.shopId));
      const shops = brand.shops.filter(shop => !evaluated.has(shop.id));
      if (!shops.length) continue;
      const orders = await this.prisma.completionRateOrder.findMany({ where: {
        applicationId: brand.applicationId!, terminalTime: { gte: day.start, lt: end },
        OR: [{ appShopId: { in: shops.map(s => s.appShopId) } }, { appShopId: null, didiShopId: { in: shops.map(s => s.shopId) } }],
      } });
      const byAppShop = new Map(shops.map(shop => [shop.appShopId, shop.id]));
      const byDidiShop = new Map(shops.map(shop => [shop.shopId, shop.id]));
      const grouped = new Map<string, Order[]>();
      for (const order of orders) {
        const shopId = order.appShopId ? byAppShop.get(order.appShopId) : byDidiShop.get(order.didiShopId ?? '');
        if (!shopId) continue;
        const rows = grouped.get(shopId) ?? [];
        rows.push(order); grouped.set(shopId, rows);
      }
      for (const shop of shops) {
        const stats = summarizeStoreOrders(grouped.get(shop.id) ?? []);
        const decision = storeCrDecision(stats.completed, stats.cancelled, stats.unknown, brand.crAutoClosureThreshold, brand.crAutoClosureMinOrders);
        try {
          await this.prisma.$transaction(async tx => {
            // Same lock as Auto Open's shared permit. A pending closure becomes
            // visible before any subsequent opening can pass its final check.
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${brand.id} AS text), 0))`;
            const current = await tx.brand.findFirst({ where: { id: brand.id, deletedAt: null, crAutoClosureEnabled: true,
              applicationId: brand.applicationId, crAutoClosureThreshold: brand.crAutoClosureThreshold,
              crAutoClosureMinOrders: brand.crAutoClosureMinOrders, application: readyApplication } });
            if (!current) return;
            const previous = await tx.storeCrClosure.findUnique({ where: { shopId_operationalStart: { shopId: shop.id, operationalStart: day.start } } });
            let reason = decision.reason;
            const reusable = previous?.status === 'suppressed' && decision.reason === 'closure_requested';
            if (previous && !reusable) reason = 'already_requested_today';
            else if (reason === 'closure_requested' && !this.destination()) reason = 'destination_unconfigured';
            await tx.storeCrDecision.create({ data: { brandId: brand.id, shopId: shop.id, windowStart: day.start, windowEnd: end,
              ...stats, completionRate: decision.cr, threshold: brand.crAutoClosureThreshold, minOrders: brand.crAutoClosureMinOrders, reason } });
            if (reason !== 'closure_requested') return;
            const data = { brandId: brand.id, shopId: shop.id, applicationId: brand.applicationId!, appShopId: shop.appShopId,
              brandName: brand.brandName, shopName: shop.name ?? shop.appShopId, operationalStart: day.start, blockedUntil: day.end,
              evaluatedAt: end, completionRate: decision.cr!, completed: stats.completed, cancelled: stats.cancelled,
              threshold: brand.crAutoClosureThreshold, minOrders: brand.crAutoClosureMinOrders };
            if (reusable) {
              await tx.storeCrClosure.update({ where: { id: previous!.id }, data: { ...data, status: 'pending', attempts: 0, error: null } });
            } else await tx.storeCrClosure.create({ data });
          }, { timeout: 15_000 });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
          this.logger.error(`CR decision could not be persisted for shop ${shop.id}; next tick will retry`);
        }
      }
    }
  }

  async processPending(now = new Date()) {
    // A process may have died after the write reached DiDi. Keep unknown results
    // blocking Auto Open, and retry only the idempotent OFF request in this day.
    await this.prisma.storeCrClosure.updateMany({ where: { status: 'closing', updatedAt: { lt: new Date(now.getTime() - 120_000) } },
      data: { status: 'unknown', error: 'Cierre interrumpido; resultado remoto sin confirmar' } });
    await this.prisma.storeCrClosure.updateMany({ where: { status: 'unknown', attempts: { gte: 3 }, notificationStatus: 'waiting' },
      data: { notificationStatus: 'pending' } });
    await this.prisma.storeCrClosure.updateMany({ where: { status: 'unknown', blockedUntil: { lte: now }, notificationStatus: 'waiting' },
      data: { notificationStatus: 'pending' } });
    await this.prisma.storeCrClosure.updateMany({ where: { status: { in: ['pending', 'failed'] }, blockedUntil: { lte: now } },
      data: { status: 'expired', error: 'El día operativo terminó antes de confirmar el cierre' } });
    if (!monitoringWindow(now)) return;
    const pending = await this.prisma.storeCrClosure.findMany({ where: { status: { in: ['pending', 'failed', 'unknown'] },
      attempts: { lt: 3 }, blockedUntil: { gt: now } }, orderBy: { createdAt: 'asc' }, take: 20 });
    for (let offset = 0; offset < pending.length; offset += 3) {
      await Promise.all(pending.slice(offset, offset + 3).map(row => this.close(row.id)));
    }
  }

  async close(id: string) {
    const row = await this.prisma.storeCrClosure.findUnique({ where: { id } });
    if (!row || !['pending', 'failed', 'unknown'].includes(row.status) || row.attempts >= 3 || row.blockedUntil <= new Date()) return;
    const attempt = row.attempts + 1;
    const claimed = await this.prisma.storeCrClosure.updateMany({ where: { id, status: row.status, attempts: row.attempts },
      data: { status: 'closing', attempts: { increment: 1 }, error: null } });
    if (!claimed.count) return;
    let writeAttempted = false;
    const priorUnknown = row.status === 'unknown';
    try {
      const app = await this.prisma.application.findFirst({ where: { id: row.applicationId, ...readyApplication } });
      if (!app) throw new Error('Application unavailable');
      const token = await getAuthToken(app.appId, decrypt(app.appSecret, this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY')), row.appShopId, AbortSignal.timeout(15_000));
      await this.prisma.$transaction(async tx => {
        const started = Date.now();
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${row.brandId} AS text), 0))`;
        const owned = await tx.storeCrClosure.findFirst({ where: { id, status: 'closing', attempts: attempt } });
        if (!owned) return;
        const shop = await tx.shop.findFirst({ where: { id: row.shopId, appShopId: row.appShopId, deletedAt: null, brandId: row.brandId,
          brand: { deletedAt: null, crAutoClosureEnabled: true, applicationId: row.applicationId, application: readyApplication } }, include: { brand: true } });
        const time = new Date();
        if (!shop || !this.destination() || !monitoringWindow(time) || row.blockedUntil <= time
          || operationalDay(shop.brand.country, time).start.getTime() !== row.operationalStart.getTime()) {
          await tx.storeCrClosure.update({ where: { id }, data: { status: priorUnknown ? 'unknown' : 'suppressed', error: 'Configuración, aplicación o día operativo ya no permite cerrar' } });
          return;
        }
        const orders = await tx.completionRateOrder.findMany({ where: { applicationId: row.applicationId,
          terminalTime: { gte: row.operationalStart, lt: time },
          OR: [{ appShopId: row.appShopId }, { appShopId: null, didiShopId: shop.shopId }] } });
        const stats = summarizeStoreOrders(orders);
        const decision = storeCrDecision(stats.completed, stats.cancelled, stats.unknown, shop.brand.crAutoClosureThreshold, shop.brand.crAutoClosureMinOrders);
        if (decision.reason !== 'closure_requested') {
          await tx.storeCrClosure.update({ where: { id }, data: { status: priorUnknown ? 'unknown' : 'suppressed', error: `Revalidación: ${decision.reason}` } });
          return;
        }
        // Leave room for the bounded provider write and commit in the 25s lease.
        if (Date.now() - started > 10_000) throw new Error('Closing permit expired');
        writeAttempted = true;
        const response = await fetch(`${DIDI_BASE}/v1/shop/shop/setStatus`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_token: token, biz_status: 2, auto_switch: 2 }), signal: AbortSignal.timeout(8_000), redirect: 'error' });
        const body = parseJsonKeepingIds(await response.text());
        if (response.status >= 500) throw new Error('Ambiguous provider response');
        const confirmed = response.ok && body.errno === 0;
        // An explicit provider error is a failed request; a missing errno is ambiguous.
        if (response.ok && typeof body.errno !== 'number') throw new Error('Invalid provider response');
        await tx.storeCrClosure.update({ where: { id }, data: {
          status: confirmed ? 'closed' : priorUnknown ? 'unknown' : 'failed', closedAt: confirmed ? new Date() : null,
          error: confirmed ? null : `DiDi rechazó el cierre (HTTP ${response.status}, errno ${Number(body.errno) || 'desconocido'})`,
          completed: stats.completed, cancelled: stats.cancelled, completionRate: decision.cr!, evaluatedAt: time,
          threshold: shop.brand.crAutoClosureThreshold, minOrders: shop.brand.crAutoClosureMinOrders,
          notificationStatus: confirmed || attempt >= 3 ? 'pending' : 'waiting',
        } });
      }, { maxWait: 5_000, timeout: 25_000 });
    } catch {
      await this.prisma.storeCrClosure.updateMany({ where: { id, status: 'closing', attempts: attempt }, data: {
        status: writeAttempted || priorUnknown ? 'unknown' : 'failed',
        error: writeAttempted || priorUnknown ? 'Resultado remoto sin confirmar; Auto Open permanece bloqueado hasta terminar el día operativo' : 'No fue posible autenticar o preparar el cierre',
        notificationStatus: attempt >= 3 ? 'pending' : 'waiting',
      } });
    }
  }

  async notify() {
    const url = this.destination();
    if (!url) return;
    await this.prisma.storeCrClosure.updateMany({ where: { notificationStatus: 'sending', notificationUpdatedAt: { lt: new Date(Date.now() - 120_000) } },
      data: { notificationStatus: 'failed' } });
    const rows = await this.prisma.storeCrClosure.findMany({ where: { notificationStatus: { in: ['pending', 'failed'] }, notificationAttempts: { lt: 3 } }, take: 30, orderBy: { createdAt: 'asc' } });
    for (const row of rows) {
      const claimed = await this.prisma.storeCrClosure.updateMany({ where: { id: row.id, notificationStatus: row.notificationStatus, notificationAttempts: row.notificationAttempts },
        data: { notificationStatus: 'sending', notificationAttempts: { increment: 1 }, notificationUpdatedAt: new Date() } });
      if (!claimed.count) continue;
      const title = row.status === 'closed' ? '🔴 Cierre automático confirmado' : row.status === 'unknown' ? '⚠️ Cierre automático sin confirmar' : '⚠️ Cierre automático fallido';
      const frontend = this.config.get<string>('FRONTEND_URL')?.replace(/\/$/, '');
      const text = `${title} — ${row.brandName}\nModelo: Static\n\n${row.shopName} (${row.appShopId})\nCR: ${row.completionRate.toFixed(2)}% · Umbral: ${row.threshold}%\nÓrdenes: ${row.completed + row.cancelled} · Completadas: ${row.completed} · Canceladas: ${row.cancelled}\nDía operativo desde: ${row.operationalStart.toISOString()}\nProtección de Auto Open hasta: ${row.blockedUntil.toISOString()}\n${row.error ?? ''}${frontend ? `\nHistorial: ${frontend}/integrations/completion-rate?brandId=${row.brandId}` : ''}`;
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok) throw new Error('D-Chat rejected');
        await this.prisma.storeCrClosure.update({ where: { id: row.id }, data: { notificationStatus: 'sent', notifiedAt: new Date(), notificationUpdatedAt: new Date() } });
      } catch {
        await this.prisma.storeCrClosure.update({ where: { id: row.id }, data: { notificationStatus: 'failed', notificationUpdatedAt: new Date() } });
      }
    }
  }
}
