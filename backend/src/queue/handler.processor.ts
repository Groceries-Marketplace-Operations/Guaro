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
  shop?: { id: string; shopId: string; appShopId: string };
}

export interface BrandShopSyncInput {
  shopId: string;
  appShopId: string;
  city?: string;
  latitude?: string | number;
  longitude?: string | number;
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
            shop: { select: { id: true, shopId: true, appShopId: true } },
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
                appSecret: encKey ? decrypt(rawBrand.application.appSecret, encKey) : '',
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
      isLastAttempt,
    };
  }
}
