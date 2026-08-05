import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StepFailureReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from '../tasks/task-engine.service';
import { WebhookSenderService, WebhookPayload } from '../webhooks/webhook-sender.service';
import { ConfigService } from '@nestjs/config';
import { decrypt } from '../common/crypto.util';

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
  city?: string;
  latitude?: string | number;
  longitude?: string | number;
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
      appId: string;
      appName: string;
      /** Decrypted app secret — never log this */
      appSecret: string;
    } | null;
  } | null;
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
  ): Promise<number>;
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
  ) {
    super();
  }

  async process(job: Job<HandlerJobData>): Promise<void> {
    const { stepInstanceId, handlerName, taskId } = job.data;
    this.logger.log(`Running handler [${handlerName}] for step ${stepInstanceId}`);

    const fn = HANDLER_REGISTRY.get(handlerName);
    if (!fn) {
      this.logger.error(`Unknown handler: ${handlerName}`);
      await this.engine.failStep(stepInstanceId, StepFailureReason.error_handler, `Unknown handler: ${handlerName}`);
      return;
    }

    const noteLines: string[] = [];
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade >= maxAttempts - 1;
    const ctx = await this.buildContext(stepInstanceId, taskId, noteLines, isLastAttempt);

    try {
      const result = await fn(ctx);
      const note = noteLines.length ? noteLines.join('\n') : undefined;
      await this.engine.completeStep(stepInstanceId, result, note);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Handler [${handlerName}] failed: ${msg}`);
      if (job.attemptsMade >= (job.opts.attempts ?? 1) - 1) {
        const note = noteLines.length ? `${msg}\n${noteLines.join('\n')}` : msg;
        await this.engine.failStep(stepInstanceId, StepFailureReason.error_handler, note);
      }
      throw err;
    }
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
              select: { appId: true, appName: true, appSecret: true },
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
          await this.prisma.$transaction(chunk.map(shop => this.prisma.shop.upsert({
            where: { shopId: shop.shopId },
            create: {
              shopId: shop.shopId,
              appShopId: shop.appShopId,
              brandId: brand.id,
              city: shop.city || null,
              latitude: shop.latitude === undefined || shop.latitude === '' ? null : String(shop.latitude),
              longitude: shop.longitude === undefined || shop.longitude === '' ? null : String(shop.longitude),
              status: 'integrated',
              createdById: task?.createdById ?? undefined,
            },
            update: {
              appShopId: shop.appShopId,
              brandId: brand.id,
              deletedAt: null,
              ...(shop.city !== undefined && { city: shop.city || null }),
              ...(shop.latitude !== undefined && shop.latitude !== '' && { latitude: String(shop.latitude) }),
              ...(shop.longitude !== undefined && shop.longitude !== '' && { longitude: String(shop.longitude) }),
            },
          })));
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
      forEachStorePromotionBatch: async (shopExternalId, callback) => {
        if (!brand) throw new Error('Task has no brand linked');
        const batchSize = 1_000;
        let offset = 0;
        let total = 0;
        while (true) {
          const promotions = await this.prisma.storePromotion.findMany({
            where: {
              shopExternalId,
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
      isLastAttempt,
    };
  }
}
