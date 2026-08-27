import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoOpenStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { AutoOpenSelectionService } from './auto-open-selection.service';
import { StoreOpeningGuardService } from './store-opening-guard.service';
import { isEmergencyConflict } from './store-emergency-status';

export { LIVE_AUTO_OPEN_EMERGENCY_STATUSES } from './auto-open-selection.service';

interface AutoOpenJobData {
  executionId: string;
  brandRunId?: string;
}

interface ShopError {
  shopId: string;
  appShopId: string;
  error: string;
}

interface CountryNotificationBrand {
  brandName: string;
  status: AutoOpenStatus;
  totalShops: number;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  errorMessage: string | null;
  shopErrors: ShopError[];
}

interface CountryNotificationInput {
  executionId: string;
  poolName: string;
  country: string;
  dryRun: boolean;
  status: AutoOpenStatus;
  totalBrands: number;
  brandsCompleted: number;
  brandsFailed: number;
  totalShops: number;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  frontendUrl: string;
  brandRuns: CountryNotificationBrand[];
}

function elapsedLabel(startedAt: Date | null, finishedAt: Date | null) {
  if (!startedAt || !finishedAt) return 'No disponible';
  const elapsedSeconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return [hours ? `${hours} h` : null, minutes ? `${minutes} min` : null, `${seconds} s`].filter(Boolean).join(' ');
}

function oneLine(value: string, maxLength = 280) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

const MAX_COUNTRY_NOTIFICATION_SHOP_ERRORS = 50;

function statusPresentation(status: AutoOpenStatus) {
  if (status === AutoOpenStatus.done) return { emoji: '✅', label: 'Completada' };
  if (status === AutoOpenStatus.partial_success) return { emoji: '⚠️', label: 'Completada con errores' };
  if (status === AutoOpenStatus.cancelled) return { emoji: '⏹️', label: 'Cancelada' };
  return { emoji: '❌', label: 'Fallida' };
}

export function buildAutoOpenCountryNotification(input: CountryNotificationInput) {
  const mode = input.dryRun ? 'DRY RUN' : 'LIVE';
  const status = statusPresentation(input.status);
  const color = input.status === AutoOpenStatus.done
    ? '#00C853'
    : input.status === AutoOpenStatus.cancelled
      ? '#667085'
      : input.status === AutoOpenStatus.partial_success
        ? '#F79009'
        : '#D92D20';
  const detailUrl = `${input.frontendUrl.replace(/\/$/, '')}/integrations/auto-open`;
  const statusCounts = input.brandRuns.reduce((counts, run) => {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
    return counts;
  }, {} as Partial<Record<AutoOpenStatus, number>>);
  const summaryLines = [
    `**Pool:** ${input.poolName}`,
    `**País:** ${input.country}`,
    `**Modo:** ${mode}`,
    `**Estado:** ${status.label}`,
    `**Marcas completadas:** ${input.brandsCompleted}/${input.totalBrands}`,
    `**Marcas con errores:** ${input.brandsFailed}`,
    `**Marcas exitosas / parciales / fallidas:** ${statusCounts.done ?? 0} / ${statusCounts.partial_success ?? 0} / ${(statusCounts.failed ?? 0) + (statusCounts.cancelled ?? 0)}`,
    `**Tiendas totales:** ${input.totalShops}`,
    `**Procesadas:** ${input.shopsProcessed}`,
    `**Candidatas para apertura:** ${input.shopsWouldOpen}`,
    `**Abiertas:** ${input.shopsOpened}`,
    `**Protegidas por emergencias:** ${input.shopsSkippedEmergency}`,
    `**Fallidas:** ${input.shopsFailed}`,
    `**Inicio:** ${input.startedAt?.toISOString() ?? 'No disponible'}`,
    `**Fin:** ${input.finishedAt?.toISOString() ?? 'No disponible'}`,
    `**Duración:** ${elapsedLabel(input.startedAt, input.finishedAt)}`,
    `**ID de ejecución:** ${input.executionId}`,
    ...(input.errorMessage ? [`**Error general:** ${oneLine(input.errorMessage, 500)}`] : []),
    `**Detalle:** ${detailUrl}`,
  ];

  const brandLines = input.brandRuns.map((run, index) => {
    const presentation = statusPresentation(run.status);
    return `${index + 1}. ${presentation.emoji} **${run.brandName}** — ${presentation.label} · `
      + `procesadas ${run.shopsProcessed}/${run.totalShops} · `
      + `${input.dryRun ? 'abriría' : 'abiertas'} ${input.dryRun ? run.shopsWouldOpen : run.shopsOpened} · `
      + `emergencias ${run.shopsSkippedEmergency} · fallidas ${run.shopsFailed}`
      + (run.errorMessage ? ` · error: ${oneLine(run.errorMessage, 220)}` : '');
  });
  const recordedErrors = input.brandRuns.flatMap(run => run.shopErrors.map(error => ({
    brandName: run.brandName,
    ...error,
  })));
  const shopErrorLines = recordedErrors.slice(0, MAX_COUNTRY_NOTIFICATION_SHOP_ERRORS).map((error, index) => (
    `${index + 1}. **${error.brandName}** · shop_id ${error.shopId} · `
    + `app_shop_id ${error.appShopId} · ${oneLine(error.error)}`
  ));
  if (recordedErrors.length > shopErrorLines.length) {
    shopErrorLines.push(
      `… ${recordedErrors.length - shopErrorLines.length} errores registrados adicionales disponibles en el detalle de Auto Open.`,
    );
  }

  return {
    text: `${status.emoji} **Auto Open Stores · ${input.country} · ${mode}**`,
    attachments: [
      {
        title: `${input.poolName} · Resumen general`,
        text: summaryLines.join('\n'),
        color,
      },
      {
        title: `Detalle por marca (${input.brandRuns.length})`,
        text: brandLines.length ? brandLines.join('\n') : 'No hubo marcas para procesar.',
        color,
      },
      ...(shopErrorLines.length ? [{
        title: `Errores de tienda registrados (${Math.min(recordedErrors.length, MAX_COUNTRY_NOTIFICATION_SHOP_ERRORS)}/${input.shopsFailed})`,
        text: shopErrorLines.join('\n'),
        color: '#D92D20',
      }] : []),
    ],
  };
}

export interface BrandLog {
  brandName: string;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  blockedByEmergency?: boolean;
  error?: string;
  shopErrors?: ShopError[];
}

function serializedShopErrors(value: Prisma.JsonValue): ShopError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const errors = value.filter((item): item is Prisma.JsonObject => (
    item !== null && !Array.isArray(item) && typeof item === 'object'
  )).flatMap(item => (
    typeof item.shopId === 'string'
    && typeof item.appShopId === 'string'
    && typeof item.error === 'string'
      ? [{ shopId: item.shopId, appShopId: item.appShopId, error: item.error }]
      : []
  ));
  return errors.length ? errors : undefined;
}

const TERMINAL_BRAND_STATUSES: AutoOpenStatus[] = [
  AutoOpenStatus.done,
  AutoOpenStatus.partial_success,
  AutoOpenStatus.failed,
  AutoOpenStatus.cancelled,
];
const MAX_RECORDED_SHOP_ERRORS = 20;

export function buildEmergencyProtection(emergencies: Array<{
  brandId: string;
  mode: string;
  targets: Array<{ shopId: string }>;
}>) {
  const blockedBrands = new Set(
    emergencies.filter(emergency => emergency.mode === 'all_brand').map(emergency => emergency.brandId),
  );
  const blockedShopsByBrand = new Map<string, Set<string>>();
  for (const emergency of emergencies.filter(emergency => emergency.mode === 'shop_list')) {
    const blocked = blockedShopsByBrand.get(emergency.brandId) ?? new Set<string>();
    emergency.targets.forEach(target => blocked.add(target.shopId));
    blockedShopsByBrand.set(emergency.brandId, blocked);
  }
  return { blockedBrands, blockedShopsByBrand };
}

async function openShop(authToken: string): Promise<void> {
  const endpoint = 'POST /v1/shop/shop/setStatus';
  const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken, biz_status: 1, auto_switch: 3 }),
    signal: AbortSignal.timeout(8_000),
  });
  const body = parseJsonKeepingIds(await response.text());
  if (!response.ok || body.errno !== 0) {
    throw new Error(`${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
  }
}

@Injectable()
@Processor('auto-open', { concurrency: 3 })
export class AutoOpenProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoOpenProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhookSenderService,
    @InjectQueue('auto-open') private readonly queue: Queue,
    private readonly selection: AutoOpenSelectionService,
    private readonly openingGuard: StoreOpeningGuardService,
  ) {
    super();
  }

  async process(job: Job<AutoOpenJobData>): Promise<void> {
    if (job.name === 'run-brand' && job.data.brandRunId) {
      await this.processBrand(job.data.executionId, job.data.brandRunId);
      return;
    }
    await this.prepareExecution(job.data.executionId);
  }

  async reconcileExecution(executionId: string): Promise<void> {
    const execution = await this.prisma.autoOpenExecution.findUnique({
      where: { id: executionId },
      include: {
        pool: { select: { id: true, name: true, country: true, webhookId: true } },
        brandRuns: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!execution || execution.status !== AutoOpenStatus.running) return;

    const completed = execution.brandRuns.filter(run => TERMINAL_BRAND_STATUSES.includes(run.status)).length;
    const brandsFailed = execution.brandRuns.filter(run => run.status !== AutoOpenStatus.done && TERMINAL_BRAND_STATUSES.includes(run.status)).length;
    const totalShops = execution.brandRuns.reduce((total, run) => total + run.totalShops, 0);
    const shopsProcessed = execution.brandRuns.reduce((total, run) => total + run.shopsProcessed, 0);
    const shopsOpened = execution.brandRuns.reduce((total, run) => total + run.shopsOpened, 0);
    const shopsWouldOpen = execution.brandRuns.reduce((total, run) => total + run.shopsWouldOpen, 0);
    const shopsSkippedEmergency = execution.brandRuns.reduce((total, run) => total + run.shopsSkippedEmergency, 0);
    const shopsFailed = execution.brandRuns.reduce((total, run) => total + run.shopsFailed, 0);
    const allComplete = execution.totalBrands === completed;
    const progressPercent = execution.totalBrands > 0
      ? Math.min(100, Math.floor((completed / execution.totalBrands) * 100))
      : 100;
    const logs = {
      mode: execution.dryRun ? 'dry_run' : 'live',
      brands: execution.brandRuns.map(run => ({
        brandName: run.brandName,
        shopsProcessed: run.shopsProcessed,
        shopsOpened: run.shopsOpened,
        shopsWouldOpen: run.shopsWouldOpen,
        shopsSkippedEmergency: run.shopsSkippedEmergency,
        shopsFailed: run.shopsFailed,
        ...(run.errorMessage ? { error: run.errorMessage } : {}),
        ...(serializedShopErrors(run.shopErrors) ? { shopErrors: serializedShopErrors(run.shopErrors) } : {}),
      })),
    } satisfies { mode: string; brands: BrandLog[] };

    const finalStatus = brandsFailed > 0 || shopsFailed > 0
      ? AutoOpenStatus.partial_success
      : AutoOpenStatus.done;
    const finishedAt = allComplete ? new Date() : null;
    const errorMessage = brandsFailed || shopsFailed
      ? `${brandsFailed} brand(s) with errors; ${shopsFailed} store opening(s) failed`
      : null;
    const updated = await this.prisma.autoOpenExecution.updateMany({
      where: { id: executionId, status: AutoOpenStatus.running },
      data: {
        brandsCompleted: completed,
        brandsFailed,
        totalShops,
        shopsOpened,
        shopsWouldOpen,
        shopsSkippedEmergency,
        shopsFailed,
        progressPercent,
        heartbeatAt: new Date(),
        logs: logs as unknown as Prisma.InputJsonValue,
        ...(allComplete ? {
          status: finalStatus,
          finishedAt,
          currentBrand: null,
          errorMessage,
        } : {}),
      },
    });
    if (!allComplete || !updated.count) return;

    if (execution.pool.webhookId) {
      await this.webhooks.sendToWebhook(
        execution.pool.webhookId,
        buildAutoOpenCountryNotification({
          executionId: execution.id,
          poolName: execution.pool.name,
          country: execution.pool.country,
          dryRun: execution.dryRun,
          status: finalStatus,
          totalBrands: execution.totalBrands,
          brandsCompleted: completed,
          brandsFailed,
          totalShops,
          shopsProcessed,
          shopsOpened,
          shopsWouldOpen,
          shopsSkippedEmergency,
          shopsFailed,
          errorMessage,
          startedAt: execution.startedAt,
          finishedAt,
          frontendUrl: this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173',
          brandRuns: execution.brandRuns.map(run => ({
            brandName: run.brandName,
            status: run.status,
            totalShops: run.totalShops,
            shopsProcessed: run.shopsProcessed,
            shopsOpened: run.shopsOpened,
            shopsWouldOpen: run.shopsWouldOpen,
            shopsSkippedEmergency: run.shopsSkippedEmergency,
            shopsFailed: run.shopsFailed,
            errorMessage: run.errorMessage,
            shopErrors: serializedShopErrors(run.shopErrors) ?? [],
          })),
        }),
      ).catch(error => {
        this.logger.error(`Auto Open country notification failed for ${executionId}: ${(error as Error).message}`);
      });
    }
    this.logger.log(
      `Auto Open ${executionId} ${execution.dryRun ? 'dry-run' : 'live'} finished: `
      + `${completed}/${execution.totalBrands} brands, ${shopsOpened} opened, ${shopsFailed} failed, `
      + `${shopsSkippedEmergency} protected`,
    );
  }

  private async prepareExecution(executionId: string): Promise<void> {
    const claimed = await this.prisma.autoOpenExecution.updateMany({
      where: { id: executionId, status: AutoOpenStatus.pending },
      data: {
        status: AutoOpenStatus.running,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        errorMessage: null,
      },
    });
    if (!claimed.count) {
      const existing = await this.prisma.autoOpenExecution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (existing?.status === AutoOpenStatus.running) await this.enqueuePendingBrandRuns(executionId);
      return;
    }

    try {
      const execution = await this.prisma.autoOpenExecution.findUnique({
        where: { id: executionId },
        include: {
          pool: {
            include: {
              brands: {
                include: { brand: { select: { id: true, brandName: true, deletedAt: true } } },
                orderBy: { brand: { brandName: 'asc' } },
              },
            },
          },
        },
      });
      if (!execution) throw new Error(`Execution ${executionId} not found`);
      this.assertRemoteWriteGates(execution.dryRun, execution.remoteWritesEnabled);

      const brands = execution.pool.brands.filter(item => !item.brand.deletedAt).map(item => item.brand);
      await this.prisma.$transaction([
        this.prisma.autoOpenBrandExecution.createMany({
          data: brands.map(brand => ({ executionId, brandId: brand.id, brandName: brand.brandName })),
          skipDuplicates: true,
        }),
        this.prisma.autoOpenExecution.update({
          where: { id: executionId },
          data: {
            totalBrands: brands.length,
            brandsCompleted: 0,
            brandsFailed: 0,
            progressPercent: brands.length ? 0 : 100,
            heartbeatAt: new Date(),
            ...(brands.length ? {} : {
              status: AutoOpenStatus.done,
              finishedAt: new Date(),
              logs: { mode: execution.dryRun ? 'dry_run' : 'live', brands: [] },
            }),
          },
        }),
      ]);
      if (brands.length) await this.enqueuePendingBrandRuns(executionId);
    } catch (error) {
      const message = (error as Error).message;
      await this.prisma.autoOpenExecution.updateMany({
        where: { id: executionId, status: AutoOpenStatus.running },
        data: {
          status: AutoOpenStatus.failed,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
          errorMessage: message,
          logs: { error: message },
        },
      });
      this.logger.error(`Auto Open execution ${executionId} could not be prepared: ${message}`);
      throw error;
    }
  }

  private async enqueuePendingBrandRuns(executionId: string) {
    const runs = await this.prisma.autoOpenBrandExecution.findMany({
      where: { executionId, status: AutoOpenStatus.pending },
      select: { id: true },
    });
    if (!runs.length) {
      await this.reconcileExecution(executionId);
      return;
    }
    await this.queue.addBulk(runs.map(run => ({
      name: 'run-brand',
      data: { executionId, brandRunId: run.id },
      opts: {
        jobId: `auto-open-brand-${run.id}`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    })));
  }

  private async processBrand(executionId: string, brandRunId: string): Promise<void> {
    const claimed = await this.prisma.autoOpenBrandExecution.updateMany({
      where: { id: brandRunId, executionId, status: AutoOpenStatus.pending },
      data: { status: AutoOpenStatus.running, startedAt: new Date(), finishedAt: null, errorMessage: null },
    });
    if (!claimed.count) return;

    try {
      const execution = await this.prisma.autoOpenExecution.findUnique({
        where: { id: executionId },
        select: { id: true, status: true, dryRun: true, remoteWritesEnabled: true },
      });
      const brandRun = await this.prisma.autoOpenBrandExecution.findUnique({
        where: { id: brandRunId },
        select: { brandId: true, brandName: true },
      });
      if (!execution || execution.status !== AutoOpenStatus.running || !brandRun) {
        await this.prisma.autoOpenBrandExecution.updateMany({
          where: { id: brandRunId, executionId, status: AutoOpenStatus.running },
          data: {
            status: AutoOpenStatus.cancelled,
            finishedAt: new Date(),
            errorMessage: 'Parent execution is no longer active',
          },
        });
        return;
      }
      this.assertRemoteWriteGates(execution.dryRun, execution.remoteWritesEnabled);

      const brand = await this.prisma.brand.findFirst({
        where: { id: brandRun.brandId, deletedAt: null },
        select: {
          id: true,
          brandName: true,
          application: { select: { appId: true, appSecret: true, deletedAt: true } },
          shops: {
            where: { deletedAt: null },
            select: { id: true, shopId: true, appShopId: true },
            orderBy: [{ shopId: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!brand) {
        await this.finishBrand(executionId, brandRunId, AutoOpenStatus.failed, {
          totalShops: 0, shopsProcessed: 0, shopsOpened: 0, shopsWouldOpen: 0,
          shopsSkippedEmergency: 0, shopsFailed: 0, errorMessage: 'Brand is no longer active', shopErrors: [],
        });
        return;
      }
      if (!brand.application || brand.application.deletedAt) {
        await this.finishBrand(executionId, brandRunId, AutoOpenStatus.failed, {
          totalShops: brand.shops.length, shopsProcessed: 0, shopsOpened: 0, shopsWouldOpen: 0,
          shopsSkippedEmergency: 0, shopsFailed: 0, errorMessage: 'No active application linked', shopErrors: [],
        });
        return;
      }

      let appSecret = '';
      if (!execution.dryRun) {
        const encryptionKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
        appSecret = encryptionKey ? decrypt(brand.application.appSecret, encryptionKey) : brand.application.appSecret;
      }

      let shopsProcessed = 0;
      let shopsOpened = 0;
      let shopsWouldOpen = 0;
      let shopsSkippedEmergency = 0;
      let shopsFailed = 0;
      const shopErrors: ShopError[] = [];

      await this.prisma.autoOpenBrandExecution.update({
        where: { id: brandRunId },
        data: { totalShops: brand.shops.length },
      });
      for (let index = 0; index < brand.shops.length; index += BATCH_SIZE) {
        const batch = brand.shops.slice(index, index + BATCH_SIZE);
        const protection = await this.selection.emergencyProtectionForBatch(
          brand.id,
          batch.map(shop => shop.id),
        );

        for (const shop of batch) {
          if (protection.blockAll || protection.blockedShopIds.has(shop.id)) {
            shopsSkippedEmergency++;
            continue;
          }
          shopsProcessed++;
          shopsWouldOpen++;
          if (execution.dryRun) continue;

          try {
            const token = await getAuthToken(
              brand.application.appId,
              appSecret,
              shop.appShopId,
              AbortSignal.timeout(30_000),
            );
            if (await this.selection.hasLiveEmergency(brand.id, shop.id)) {
              shopsProcessed--;
              shopsWouldOpen--;
              shopsSkippedEmergency++;
              continue;
            }
            await this.openingGuard.withOpeningPermit({
              shopId: shop.id,
              operation: 'auto_open',
              execute: () => openShop(token),
            });
            shopsOpened++;
          } catch (error) {
            if (isEmergencyConflict(error)) {
              shopsProcessed--;
              shopsWouldOpen--;
              shopsSkippedEmergency++;
              continue;
            }
            shopsFailed++;
            if (shopErrors.length < MAX_RECORDED_SHOP_ERRORS) {
              shopErrors.push({ shopId: shop.shopId, appShopId: shop.appShopId, error: (error as Error).message });
            }
          }
        }

        await this.checkpointBrand(executionId, brandRunId, brand.brandName, {
          shopsProcessed, shopsOpened, shopsWouldOpen, shopsSkippedEmergency, shopsFailed, shopErrors,
        });
        if (!execution.dryRun && index + BATCH_SIZE < brand.shops.length) await sleep(COOLDOWN_BATCH_MS);
      }

      await this.finishBrand(executionId, brandRunId, shopsFailed ? AutoOpenStatus.partial_success : AutoOpenStatus.done, {
        totalShops: brand.shops.length,
        shopsProcessed,
        shopsOpened,
        shopsWouldOpen,
        shopsSkippedEmergency,
        shopsFailed,
        errorMessage: shopsFailed ? `${shopsFailed} store opening(s) failed` : null,
        shopErrors,
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Auto Open brand run ${brandRunId} failed: ${message}`);
      await this.finishBrand(executionId, brandRunId, AutoOpenStatus.failed, { errorMessage: message });
    }
  }

  private async checkpointBrand(
    executionId: string,
    brandRunId: string,
    brandName: string,
    metrics: {
      shopsProcessed: number;
      shopsOpened: number;
      shopsWouldOpen: number;
      shopsSkippedEmergency: number;
      shopsFailed: number;
      shopErrors: ShopError[];
    },
  ) {
    await this.prisma.$transaction([
      this.prisma.autoOpenBrandExecution.update({
        where: { id: brandRunId },
        data: { ...metrics, shopErrors: metrics.shopErrors as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.autoOpenExecution.updateMany({
        where: { id: executionId, status: AutoOpenStatus.running },
        data: { currentBrand: brandName, heartbeatAt: new Date() },
      }),
    ]);
  }

  private async finishBrand(
    executionId: string,
    brandRunId: string,
    status: AutoOpenStatus,
    data: Partial<{
      totalShops: number;
      shopsProcessed: number;
      shopsOpened: number;
      shopsWouldOpen: number;
      shopsSkippedEmergency: number;
      shopsFailed: number;
      errorMessage: string | null;
      shopErrors: ShopError[];
    }>,
  ) {
    await this.prisma.autoOpenBrandExecution.update({
      where: { id: brandRunId },
      data: {
        ...data,
        shopErrors: undefined,
        status,
        finishedAt: new Date(),
        ...(data.shopErrors ? { shopErrors: data.shopErrors as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    await this.reconcileExecution(executionId);
  }

  private assertRemoteWriteGates(dryRun: boolean, executionWritesEnabled: boolean) {
    const serverWritesEnabled = this.config.get<string>('AUTO_OPEN_REMOTE_WRITE_ENABLED')?.trim().toLowerCase() === 'true';
    if (!dryRun && (!executionWritesEnabled || !serverWritesEnabled)) {
      throw new Error('Live Auto Open was stopped because remote writes are disabled on this server');
    }
  }
}
