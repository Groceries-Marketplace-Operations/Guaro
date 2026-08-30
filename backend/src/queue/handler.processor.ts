import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DayOfWeek, ShopPickingModel, StepFailureReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { catalogMutationResourceKey, OperationalLeaseService } from '../prisma/operational-lease.service';
import { TaskEngineService } from '../tasks/task-engine.service';
import { WebhookSenderService, WebhookPayload } from '../webhooks/webhook-sender.service';
import { ConfigService } from '@nestjs/config';
import { decrypt } from '../common/crypto.util';
import {
  TargetedPromotionReaderService,
  TargetedPromotionRefreshResult,
} from '../file-integrations/targeted-promotion-reader.service';

// ── Job payload (what travels in the BullMQ queue) ───────────────────────────

export interface HandlerJobData {
  stepInstanceId: string;
  handlerName: string;
  taskId: string;
}

// ── Rich context built at runtime before calling the handler ─────────────────

export interface FormValueCtx {
  label: string;
  tipo: string;
  /** String value for texto/numero/link/select fields */
  valor: string | null;
  /** Resolved brand when tipo = select_brand */
  brand?: { id: string; brandId: string; brandName: string; country: string };
  /** Resolved shop when tipo = select_store */
  shop?: { id: string; shopId: string; appShopId: string; brandId: string };
}

export interface BrandItemExportRow {
  name: string;
  upc: string | null;
  appItemId: string;
  imageUrl: string | null;
  sourceShopId: string | null;
  sourceCity: string | null;
  lastSeenAt: Date;
}

export interface BrandShopSyncInput {
  shopId: string;
  appShopId: string;
  name?: string;
  city?: string;
  latitude?: string | number;
  longitude?: string | number;
  pickingModel?: ShopPickingModel;
  driverCashBlocked?: boolean;
  schedules?: Array<{ day: DayOfWeek; openTime: string; closeTime: string }>;
}

export interface StorePromotionExportRow {
  sourceAccount: string;
  shopExternalId: string;
  shopId?: string | null;
  shopName?: string | null;
  shopCity?: string | null;
  activityId: string;
  activityName: string | null;
  startDate: string | null;
  endDate: string | null;
  activityType: number | null;
  sku: string;
  discountAmount: string | null;
  discountPercentage: string | null;
  buyNum: string | null;
  getNum: string | null;
  bxgyX: string | null;
  bxgyY: string | null;
  actionType: number | null;
  sourceFile: string;
  fetchedAt: Date;
}

export interface HandlerContext {
  stepInstanceId: string;
  taskId: string;
  /** All form values submitted for this task */
  formValues: FormValueCtx[];
  /** Brand linked to the task (null if task has no brand) */
  brand: {
    id: string;
    brandId: string;
    brandName: string;
    country: string;
    kaType: string | null;
    category: string | null;
    application: {
      id: string;
      appId: string;
      appName: string;
      /** Decrypted app secret — never log this */
      appSecret: string;
    } | null;
  } | null;
  /** Stores snapshotted when the task was created. */
  targetShops: Array<{
    id: string;
    shopId: string;
    appShopId: string;
    name: string | null;
    city: string | null;
  }>;
  /** Active destination categories configured for the linked brand. */
  menuCategories: Array<{ categoryId: string; name: string; order: number }>;
  /** Helper: get a form value by its field label */
  field(label: string): string | null;
  /** Accumulate a line in the step note (shown in UI after completion/failure) */
  addNote(text: string): void;
  /** Send a message to all alert webhooks */
  sendAlert(payload: WebhookPayload): Promise<void>;
  /** Persist stores returned by a brand integration without exposing Prisma to handlers. */
  syncBrandShops(shops: BrandShopSyncInput[]): Promise<{ total: number; created: number; updated: number }>;
  /** Read the local catalog in bounded batches without exposing Prisma to handlers. */
  forEachBrandItemBatch(
    callback: (items: BrandItemExportRow[]) => Promise<void> | void,
  ): Promise<number>;
  /** Read the current promotion snapshot for one store in bounded batches. */
  forEachStorePromotionBatch(
    shopExternalId: string,
    callback: (promotions: StorePromotionExportRow[]) => Promise<void> | void,
    sftpApplicationId?: string,
  ): Promise<number>;
  /** Refresh one selected store directly from its brand SFTP account. */
  refreshSelectedStorePromotions(shopExternalId: string): Promise<TargetedPromotionRefreshResult>;
  /** Serialize a mutating DiDi catalog operation for one Application/store. */
  runWithCatalogLease<T>(
    appShopId: string,
    operation: string,
    action: (ensureActive: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
  /** Read every current promotion linked to the task brand in bounded batches. */
  forEachBrandPromotionBatch(
    callback: (promotions: StorePromotionExportRow[]) => Promise<void> | void,
  ): Promise<number>;
  /** True when this is the final BullMQ attempt — safe to clean up temp resources */
  isLastAttempt: boolean;
}

// ── Handler function type ─────────────────────────────────────────────────────

export type HandlerFn = (ctx: HandlerContext) => Promise<unknown>;

// ── Global registry ───────────────────────────────────────────────────────────

const HANDLER_REGISTRY = new Map<string, HandlerFn>();

export function registerHandler(name: string, fn: HandlerFn) {
  HANDLER_REGISTRY.set(name, fn);
}

// ── Processor ─────────────────────────────────────────────────────────────────

@Processor('handlers', { concurrency: 5 })
export class HandlerProcessor extends WorkerHost {
  private readonly logger = new Logger(HandlerProcessor.name);

  constructor(
    private engine: TaskEngineService,
    private prisma: PrismaService,
    private config: ConfigService,
    private webhooks: WebhookSenderService,
    private targetedPromotionReader: TargetedPromotionReaderService,
    private operationalLeases: OperationalLeaseService,
  ) {
    super();
  }

  async process(job: Job<HandlerJobData>): Promise<void> {
    const { stepInstanceId, handlerName, taskId } = job.data;
    this.logger.log(`Running handler [${handlerName}] for step ${stepInstanceId}`);

    const fn = HANDLER_REGISTRY.get(handlerName);
    const noteLines: string[] = [];
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade >= maxAttempts - 1;
    let terminalHandlerError: unknown;

    const executed = await this.engine.runAutomaticHandlerUnderFence(stepInstanceId, taskId, async () => {
      if (!fn) {
        this.logger.error(`Unknown handler: ${handlerName}`);
        return {
          status: 'failed' as const,
          failureReason: StepFailureReason.error_handler,
          note: `Unknown handler: ${handlerName}`,
        };
      }
      const ctx = await this.buildContext(stepInstanceId, taskId, noteLines, isLastAttempt);
      try {
        const result = await fn(ctx);
        const note = noteLines.length ? noteLines.join('\n') : undefined;
        return { status: 'completed' as const, result, note };
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`Handler [${handlerName}] failed: ${msg}`);
        if (job.attemptsMade >= (job.opts.attempts ?? 1) - 1) {
          const note = noteLines.length ? `${msg}\n${noteLines.join('\n')}` : msg;
          terminalHandlerError = err;
          return { status: 'failed' as const, failureReason: StepFailureReason.error_handler, note };
        }
        throw err;
      }
    });
    if (!executed) {
      this.logger.log(`Skipped stale or disabled handler [${handlerName}] for step ${stepInstanceId}`);
    }
    // Keep BullMQ retry/rejection semantics identical to the legacy worker:
    // the final attempt is persisted as failed, then the original handler
    // error is rethrown so the job itself is not reported as completed.
    if (terminalHandlerError) throw terminalHandlerError;
  }

  // ── Context builder ───────────────────────────────────────────────────────

  private async buildContext(stepInstanceId: string, taskId: string, noteLines: string[], isLastAttempt: boolean): Promise<HandlerContext> {
    const encKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        brand: {
          include: {
            application: {
              select: { id: true, appId: true, appName: true, appSecret: true },
            },
          },
        },
        formValues: {
          include: {
            formField: { select: { label: true, tipo: true } },
            brand: { select: { id: true, brandId: true, brandName: true, country: true } },
            shop: { select: { id: true, shopId: true, appShopId: true, brandId: true } },
          },
        },
        taskShops: {
          include: {
            shop: { select: { id: true, shopId: true, appShopId: true, name: true, city: true } },
          },
        },
      },
    });

    const formValues: FormValueCtx[] = (task?.formValues ?? []).map((fv) => ({
      label: fv.formField.label,
      tipo: fv.formField.tipo,
      valor: fv.valor,
      brand: fv.brand ?? undefined,
      shop: fv.shop ?? undefined,
    }));

    const rawBrand = task?.brand ?? null;
    const menuCategories = rawBrand
      ? await this.prisma.brandMenuCategory.findMany({
          where: { brandId: rawBrand.id, active: true },
          select: { categoryId: true, name: true, order: true },
          orderBy: [{ order: 'asc' }, { name: 'asc' }],
        })
      : [];
    const brand = rawBrand
      ? {
          id: rawBrand.id,
          brandId: rawBrand.brandId,
          brandName: rawBrand.brandName,
          country: rawBrand.country,
          kaType: rawBrand.kaType,
          category: rawBrand.category,
          application: rawBrand.application
            ? {
                id: rawBrand.application.id,
                appId: rawBrand.application.appId,
                appName: rawBrand.application.appName,
                // Decrypt only when a remote integration actually reads the secret.
                // Local-only handlers can operate on copied production data safely.
                get appSecret() {
                  if (!encKey) throw new Error('APP_SECRET_ENCRYPTION_KEY is not configured');
                  try {
                    return decrypt(rawBrand.application!.appSecret, encKey);
                  } catch {
                    throw new Error(
                      `Application credential for ${rawBrand.application!.appName} could not be decrypted `
                      + 'with the current APP_SECRET_ENCRYPTION_KEY',
                    );
                  }
                },
              }
            : null,
        }
      : null;

    return {
      stepInstanceId,
      taskId,
      formValues,
      brand,
      targetShops: (task?.taskShops ?? []).map(target => target.shop),
      menuCategories,
      field: (label) => formValues.find((f) => f.label === label)?.valor ?? null,
      addNote: (text: string) => { noteLines.push(text); },
      sendAlert: (payload: WebhookPayload) => this.webhooks.sendAlert(payload),
      syncBrandShops: async (shops) => {
        if (!brand) throw new Error('Task has no brand linked');

        const unique = [...new Map(
          shops
            .filter(shop => shop.shopId?.trim() && shop.appShopId?.trim())
            .map(shop => [shop.shopId.trim(), { ...shop, shopId: shop.shopId.trim(), appShopId: shop.appShopId.trim() }]),
        ).values()];
        if (unique.length === 0) return { total: 0, created: 0, updated: 0 };

        const existing = await this.prisma.shop.findMany({
          where: { shopId: { in: unique.map(shop => shop.shopId) } },
          select: { shopId: true },
        });
        const existingIds = new Set(existing.map(shop => shop.shopId));

        for (let offset = 0; offset < unique.length; offset += 100) {
          const chunk = unique.slice(offset, offset + 100);
          await this.prisma.$transaction(async tx => {
            for (const shop of chunk) {
              const saved = await tx.shop.upsert({
                where: { shopId: shop.shopId },
                create: {
                  shopId: shop.shopId,
                  appShopId: shop.appShopId,
                  brandId: brand.id,
                  name: shop.name || null,
                  city: shop.city || null,
                  latitude: shop.latitude === undefined || shop.latitude === '' ? null : String(shop.latitude),
                  longitude: shop.longitude === undefined || shop.longitude === '' ? null : String(shop.longitude),
                  pickingModel: shop.pickingModel,
                  driverCashBlocked: shop.driverCashBlocked ?? true,
                  status: 'integrated',
                  createdById: task?.createdById ?? undefined,
                },
                update: {
                  appShopId: shop.appShopId,
                  brandId: brand.id,
                  status: 'integrated',
                  deletedAt: null,
                  ...(shop.name !== undefined && { name: shop.name || null }),
                  ...(shop.city !== undefined && { city: shop.city || null }),
                  ...(shop.latitude !== undefined && shop.latitude !== '' && { latitude: String(shop.latitude) }),
                  ...(shop.longitude !== undefined && shop.longitude !== '' && { longitude: String(shop.longitude) }),
                  ...(shop.pickingModel !== undefined && { pickingModel: shop.pickingModel }),
                  ...(shop.driverCashBlocked !== undefined && { driverCashBlocked: shop.driverCashBlocked }),
                },
              });
              if (shop.schedules !== undefined) {
                await tx.schedule.deleteMany({ where: { shopId: saved.id } });
                if (shop.schedules.length) {
                  await tx.schedule.createMany({
                    data: shop.schedules.map(schedule => ({
                      shopId: saved.id,
                      day: schedule.day,
                      openTime: new Date(`1970-01-01T${schedule.openTime}:00.000Z`),
                      closeTime: new Date(`1970-01-01T${schedule.closeTime}:00.000Z`),
                    })),
                  });
                }
              }
            }
          });
        }

        const updated = unique.filter(shop => existingIds.has(shop.shopId)).length;
        return { total: unique.length, created: unique.length - updated, updated };
      },
      forEachBrandItemBatch: async (callback) => {
        if (!brand) throw new Error('Task has no brand linked');
        const batchSize = 1_000;
        let offset = 0;
        let total = 0;
        while (true) {
          const items = await this.prisma.brandItem.findMany({
            where: { brandId: brand.id },
            select: {
              name: true,
              upc: true,
              appItemId: true,
              imageUrl: true,
              sourceShopId: true,
              sourceCity: true,
              lastSeenAt: true,
            },
            orderBy: [{ name: 'asc' }, { appItemId: 'asc' }, { id: 'asc' }],
            skip: offset,
            take: batchSize,
          });
          if (items.length === 0) break;
          await callback(items);
          total += items.length;
          offset += items.length;
          if (items.length < batchSize) break;
        }
        return total;
      },
      forEachStorePromotionBatch: async (shopExternalId, callback, sftpApplicationId) => {
        if (!brand) throw new Error('Task has no brand linked');
        const batchSize = 1_000;
        let offset = 0;
        let total = 0;
        while (true) {
          const promotions = await this.prisma.storePromotion.findMany({
            where: {
              shopExternalId,
              ...(sftpApplicationId ? { sftpApplicationId } : {}),
              sftpApplication: { brandId: brand.id, active: true, deletedAt: null },
            },
            select: {
              shopExternalId: true,
              activityId: true,
              activityName: true,
              startDate: true,
              endDate: true,
              activityType: true,
              sku: true,
              discountAmount: true,
              discountPercentage: true,
              buyNum: true,
              getNum: true,
              bxgyX: true,
              bxgyY: true,
              actionType: true,
              sourceFile: true,
              fetchedAt: true,
              sftpApplication: { select: { name: true } },
            },
            orderBy: [{ activityId: 'asc' }, { sku: 'asc' }, { id: 'asc' }],
            skip: offset,
            take: batchSize,
          });
          if (promotions.length === 0) break;
          await callback(promotions.map(value => ({
            sourceAccount: value.sftpApplication.name,
            shopExternalId: value.shopExternalId,
            activityId: value.activityId,
            activityName: value.activityName,
            startDate: value.startDate,
            endDate: value.endDate,
            activityType: value.activityType,
            sku: value.sku,
            discountAmount: value.discountAmount,
            discountPercentage: value.discountPercentage,
            buyNum: value.buyNum,
            getNum: value.getNum,
            bxgyX: value.bxgyX,
            bxgyY: value.bxgyY,
            actionType: value.actionType,
            sourceFile: value.sourceFile,
            fetchedAt: value.fetchedAt,
          })));
          total += promotions.length;
          offset += promotions.length;
          if (promotions.length < batchSize) break;
        }
        return total;
      },
      refreshSelectedStorePromotions: async (shopExternalId) => {
        if (!brand) throw new Error('Task has no brand linked');
        return this.targetedPromotionReader.refreshSelectedStore(brand.id, shopExternalId);
      },
      forEachBrandPromotionBatch: async (callback) => {
        if (!brand) throw new Error('Task has no brand linked');
        const batchSize = 1_000;
        let offset = 0;
        let total = 0;
        while (true) {
          const promotions = await this.prisma.storePromotion.findMany({
            where: {
              sftpApplication: { brandId: brand.id, active: true, deletedAt: null },
            },
            select: {
              shopExternalId: true,
              activityId: true,
              activityName: true,
              startDate: true,
              endDate: true,
              activityType: true,
              sku: true,
              discountAmount: true,
              discountPercentage: true,
              buyNum: true,
              getNum: true,
              bxgyX: true,
              bxgyY: true,
              actionType: true,
              sourceFile: true,
              fetchedAt: true,
              sftpApplication: { select: { name: true } },
            },
            orderBy: [{ shopExternalId: 'asc' }, { activityId: 'asc' }, { sku: 'asc' }, { id: 'asc' }],
            skip: offset,
            take: batchSize,
          });
          if (promotions.length === 0) break;
          const appShopIds = [...new Set(promotions.map(value => value.shopExternalId))];
          const shops = await this.prisma.shop.findMany({
            where: { brandId: brand.id, deletedAt: null, appShopId: { in: appShopIds } },
            select: { shopId: true, appShopId: true, name: true, city: true },
          });
          const shopByAppId = new Map(shops.map(shop => [shop.appShopId, shop]));
          await callback(promotions.map(value => {
            const shop = shopByAppId.get(value.shopExternalId);
            return {
              sourceAccount: value.sftpApplication.name,
              shopExternalId: value.shopExternalId,
              shopId: shop?.shopId ?? null,
              shopName: shop?.name ?? null,
              shopCity: shop?.city ?? null,
              activityId: value.activityId,
              activityName: value.activityName,
              startDate: value.startDate,
              endDate: value.endDate,
              activityType: value.activityType,
              sku: value.sku,
              discountAmount: value.discountAmount,
              discountPercentage: value.discountPercentage,
              buyNum: value.buyNum,
              getNum: value.getNum,
              bxgyX: value.bxgyX,
              bxgyY: value.bxgyY,
              actionType: value.actionType,
              sourceFile: value.sourceFile,
              fetchedAt: value.fetchedAt,
            };
          }));
          total += promotions.length;
          offset += promotions.length;
          if (promotions.length < batchSize) break;
        }
        return total;
      },
      runWithCatalogLease: async (appShopId, operation, action) => {
        if (!brand?.application) throw new Error('Task brand has no linked application');
        const normalizedShopId = appShopId.trim();
        if (!normalizedShopId) throw new Error('app_shop_id is required for catalog coordination');
        return this.operationalLeases.runExclusive({
          resourceKey: catalogMutationResourceKey(brand.application.id, normalizedShopId),
          ownerKind: `task-handler:${operation.trim() || 'catalog-write'}`,
          ownerId: `${stepInstanceId}:${normalizedShopId}`,
          ttlMs: 5 * 60_000,
          heartbeatIntervalMs: 30_000,
          wait: true,
          waitTimeoutMs: 15 * 60_000,
          retryDelayMs: 1_000,
        }, async lease => action(async () => {
          await lease.ensureActive();
        }));
      },
      isLastAttempt,
    };
  }
}
