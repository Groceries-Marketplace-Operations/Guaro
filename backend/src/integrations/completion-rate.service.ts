import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCancellationDetail } from '../didi-order-webhooks/resolve-cancellation-detail';
import { UpdateCompletionRateDto } from './dto/update-completion-rate.dto';
import { classifyOrder, evaluateRate, monitoringWindow } from './completion-rate.util';
import { StoreCrService } from './store-cr.service';
import { closureDestination } from './store-cr.util';

const brandSelect = {
  id: true, brandName: true, country: true, applicationId: true,
  crAlertsEnabled: true, crBaselineCancelRate: true, crDeviationPoints: true, crMinOrders: true,
  crAutoClosureEnabled: true, crAutoClosureThreshold: true, crAutoClosureMinOrders: true,
  application: { select: { appName: true, deletedAt: true, orderWebhookCreatedAt: true, orderWebhookDisabledAt: true, orderWebhookTokenHash: true } },
  _count: { select: { shops: { where: { deletedAt: null } } } },
} satisfies Prisma.BrandSelect;

@Injectable()
export class CompletionRateService {
  private readonly logger = new Logger(CompletionRateService.name);
  private ticking = false;
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    @Optional() private readonly storeCr?: StoreCrService) {}

  private destination() {
    const base = this.config.get<string>('DCHAT_URL');
    const group = this.config.get<string>('DCHAT_GROUP_ID');
    if (!base || !group) return null;
    try {
      const url = new URL(base + group);
      return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
  }

  async list() {
    const brands = await this.prisma.brand.findMany({ where: { deletedAt: null }, select: brandSelect, orderBy: { brandName: 'asc' } });
    return { dchatConfigured: !!this.destination(), closureDchatConfigured: !!closureDestination(this.config.get<string>('DCHAT_URL'), this.config.get<string>('DCHAT_STORE_CLOSURE_GROUP_ID')), brands: brands.map(({ application, ...brand }) => ({
      ...brand, application: application ? { appName: application.appName } : null,
      webhookReady: !!application && !application.deletedAt && !!application.orderWebhookCreatedAt && !!application.orderWebhookTokenHash && !application.orderWebhookDisabledAt,
    })) };
  }

  async update(id: string, dto: UpdateCompletionRateDto) {
    const brand = await this.prisma.brand.findFirst({ where: { id, deletedAt: null }, select: brandSelect });
    if (!brand) throw new NotFoundException('Brand not found');
    const app = brand.application;
    const closureEnabled = dto.crAutoClosureEnabled ?? brand.crAutoClosureEnabled;
    if ((dto.crAlertsEnabled || closureEnabled) && (!app || app.deletedAt || !app.orderWebhookCreatedAt || !app.orderWebhookTokenHash || app.orderWebhookDisabledAt)) {
      throw new BadRequestException('Associate the brand with an application with an active DiDi Order Webhook first');
    }
    if (dto.crBaselineCancelRate + dto.crDeviationPoints > 100) throw new BadRequestException('Baseline plus deviation must not exceed 100%');
    if (dto.crAlertsEnabled && !this.destination()) throw new BadRequestException('Configure the shared D-Chat destination first');
    if (closureEnabled && !closureDestination(this.config.get<string>('DCHAT_URL'), this.config.get<string>('DCHAT_STORE_CLOSURE_GROUP_ID'))) {
      throw new BadRequestException('Configure the dedicated D-Chat group for store closures first');
    }
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${id} AS text), 0))`;
      await tx.brand.update({ where: { id }, data: dto });
    }, { timeout: 15_000 });
    return { ok: true };
  }

  history(brandId: string) {
    return this.prisma.completionRateRun.findMany({ where: { brandId }, orderBy: { windowEnd: 'desc' }, take: 100 });
  }

  storeHistory(brandId: string) {
    return this.storeCr!.history(brandId);
  }

  // Generic cancellation events do not identify the responsible party. Resolve
  // them using the same DiDi order-detail endpoint as grocery_tools.
  private async resolveCancellations() {
    const brands = await this.prisma.brand.findMany({ where: { OR: [{ crAlertsEnabled: true }, { crAutoClosureEnabled: true }], deletedAt: null, applicationId: { not: null } }, select: { applicationId: true }, distinct: ['applicationId'] });
    const orders = await this.prisma.completionRateOrder.findMany({
      where: { status: 170, applicationId: { in: brands.map(b => b.applicationId!) }, terminalTime: { gte: new Date(Date.now() - 26 * 60 * 60_000) } },
      orderBy: { updatedAt: 'asc' }, take: 20,
    });
    for (let offset = 0; offset < orders.length; offset += 5) {
    await Promise.all(orders.slice(offset, offset + 5).map(async order => {
      // Rotate unresolved orders so one provider failure cannot starve later ones.
      await this.prisma.completionRateOrder.updateMany({ where: { id: order.id, status: order.status }, data: { updatedAt: new Date() } });
      const app = await this.prisma.application.findFirst({ where: { id: order.applicationId, deletedAt: null, orderWebhookDisabledAt: null,
        brands: { some: { OR: [{ crAlertsEnabled: true }, { crAutoClosureEnabled: true }], deletedAt: null } } } });
      if (!app) return;
      try {
        await resolveCancellationDetail(this.prisma, this.config.getOrThrow('APP_SECRET_ENCRYPTION_KEY'), app, order);
      } catch { this.logger.warn('Could not resolve cancellation source; it remains marked as unknown'); }
    }));
    }
  }

  @Cron('0 * * * * *')
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const end = monitoringWindow(new Date());
      if (end) {
        await this.resolveCancellations();
        const evaluations = await Promise.allSettled([this.evaluate(end), this.storeCr?.evaluate(end)]);
        for (const evaluation of evaluations) {
          if (evaluation.status === 'rejected') this.logger.error('A CR evaluation failed; next tick will retry');
        }
      }
    } catch { this.logger.error('Completion rate monitoring failed; will retry on the next tick'); }
    try {
      await this.storeCr?.processPending();
    } catch { this.logger.error('Store CR closure processing failed; will retry on the next tick'); }
    try {
      await this.deliver();
      await this.storeCr?.notify();
    } catch { this.logger.error('CR notification delivery failed; will retry on the next tick'); }
    finally { this.ticking = false; }
  }

  async evaluate(end: Date) {
    const start = new Date(end.getTime() - 900_000);
    const brands = await this.prisma.brand.findMany({ where: { deletedAt: null, crAlertsEnabled: true,
      application: { deletedAt: null, orderWebhookCreatedAt: { not: null }, orderWebhookTokenHash: { not: null }, orderWebhookDisabledAt: null } },
      include: { shops: { where: { deletedAt: null }, select: { appShopId: true, shopId: true, name: true } } },
    });
    for (const brand of brands) {
      const existing = await this.prisma.completionRateRun.findUnique({ where: { brandId_windowEnd: { brandId: brand.id, windowEnd: end } } });
      if (existing) continue;
      const orders = await this.prisma.completionRateOrder.findMany({ where: {
        applicationId: brand.applicationId!, terminalTime: { gte: start, lt: end },
        OR: [{ appShopId: { in: brand.shops.map(s => s.appShopId) } }, { appShopId: null, didiShopId: { in: brand.shops.map(s => s.shopId) } }],
      } });
      let completed = 0, cancelled = 0, unknown = 0;
      const orderIds = { completed: [] as string[], cancelled: [] as string[], unknown: [] as string[] };
      const cancelledIds = orderIds.cancelled;
      const shops = new Map<string, { completed: number; cancelled: number }>();
      for (const order of orders) {
        const category = classifyOrder(order);
        if (category === 'unknown') { unknown++; orderIds.unknown.push(order.orderId); continue; }
        if (category === 'excluded') continue;
        const shop = brand.shops.find(s => order.appShopId ? s.appShopId === order.appShopId : s.shopId === order.didiShopId)!;
        const key = `${shop.name ?? shop.appShopId} (${shop.appShopId})`;
        const counts = shops.get(key) ?? { completed: 0, cancelled: 0 };
        counts[category]++;
        shops.set(key, counts);
        if (category === 'completed') { completed++; orderIds.completed.push(order.orderId); }
        else { cancelled++; cancelledIds.push(order.orderId); }
      }
      const rate = evaluateRate(completed, cancelled, brand.crBaselineCancelRate, brand.crDeviationPoints, brand.crMinOrders);
      // Do not issue a misleading alert while cancellation attribution is missing.
      // Retry within the quarter-hour, then retain an explicit incomplete record.
      if (unknown && Date.now() < end.getTime() + 14 * 60_000) continue;
      const alert = rate.alert && unknown === 0;
      const shopText = [...shops].sort((a, b) => a[1].completed / (a[1].completed + a[1].cancelled) - b[1].completed / (b[1].completed + b[1].cancelled))
        .map(([name, c]) => `${name}: ${c.completed + c.cancelled} órdenes, CR ${(100 * c.completed / (c.completed + c.cancelled)).toFixed(2)}%`).join('\n');
      const message = alert ? `⚠️ Incremento anormal en el Cancel Rate de ${brand.brandName} ⚠️\n\nCompletion Rate Actual: ${rate.completionRate}%\nCancel Rate Actual: ${(100 - rate.completionRate!).toFixed(2)}%\nÓrdenes calculadas: ${rate.total}\nVentana: ${start.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} – ${end.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} (CDMX)\n\nTiendas afectadas:\n${shopText}\n\nOrder IDs con cancelación:\n${cancelledIds.join('\n')}` : null;
      try {
        await this.prisma.completionRateRun.create({ data: { brandId: brand.id, windowEnd: end, completed, cancelled, unknown, orderIds,
          completionRate: rate.completionRate, baseline: brand.crBaselineCancelRate, deviation: brand.crDeviationPoints, minOrders: brand.crMinOrders,
          status: unknown ? 'incomplete' : alert ? 'pending' : rate.total < brand.crMinOrders ? 'insufficient_orders' : 'healthy', message } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      }
    }
  }

  async deliver() {
    const url = this.destination();
    if (!url) return;
    await this.prisma.completionRateRun.updateMany({ where: { status: { in: ['pending', 'failed'] }, brand: { OR: [
      { crAlertsEnabled: false }, { deletedAt: { not: null } }, { applicationId: null },
      { application: { OR: [{ deletedAt: { not: null } }, { orderWebhookDisabledAt: { not: null } }, { orderWebhookTokenHash: null }] } },
    ] } }, data: { status: 'suppressed', error: 'Brand monitoring or application webhook is disabled' } });
    // Recover a delivery interrupted by a process restart. D-Chat does not expose
    // idempotency keys, so a crash after provider acceptance may repeat a message.
    await this.prisma.completionRateRun.updateMany({ where: { status: 'sending', updatedAt: { lt: new Date(Date.now() - 120_000) } }, data: { status: 'failed', error: 'Delivery interrupted' } });
    const runs = await this.prisma.completionRateRun.findMany({ where: { status: { in: ['pending', 'failed'] }, attempts: { lt: 3 } }, take: 50, orderBy: { windowEnd: 'asc' } });
    for (const run of runs) {
      const claimed = await this.prisma.completionRateRun.updateMany({ where: { id: run.id, status: run.status, attempts: run.attempts }, data: { status: 'sending', attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: run.message }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok) throw new Error(`D-Chat HTTP ${response.status}`);
        await this.prisma.completionRateRun.update({ where: { id: run.id }, data: { status: 'sent', sentAt: new Date(), error: null } });
      } catch {
        await this.prisma.completionRateRun.update({ where: { id: run.id }, data: { status: 'failed', error: 'D-Chat delivery failed or timed out' } });
      }
    }
  }
}
