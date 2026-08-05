import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PromotionApiMode } from '@prisma/client';
import { decrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { fetchWithEndpointContext, getAuthToken, parseJsonKeepingIds } from '../queue/handlers/didi-food.util';
import { ExecutePromotionDto } from './dto/execute-promotion.dto';

const ENDPOINT = 'POST /v1/promo/promo/uploadGrocery';
const URL = 'https://openapi.99food.com/v1/promo/promo/uploadGrocery';

interface PromoItem {
  app_item_id?: unknown;
  discount_perc?: unknown;
  discount_amount?: unknown;
  buy_num?: unknown;
  get_num?: unknown;
  bxgy_x?: unknown;
  bxgy_y?: unknown;
}

interface PromoActivity {
  action?: unknown;
  activity_id?: unknown;
  activity_type?: unknown;
  activity_name?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  item_activity_list?: unknown;
}

@Injectable()
export class PromotionApiService {
  private readonly encryptionKey: string;
  private readonly liveEnabled: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.liveEnabled = config.get('PROMOTIONS_API_LIVE_ENABLED', 'false') === 'true';
  }

  contract() {
    return {
      endpoint: ENDPOINT,
      liveEnabled: this.liveEnabled,
      activityTypes: [
        { value: 2, label: 'Special price' },
        { value: 4, label: 'Buy X get Y' },
        { value: 8, label: 'Buy X for amount Y' },
      ],
      itemIdTypes: [{ value: 0, label: 'app_item_id' }, { value: 1, label: 'UPC' }],
    };
  }

  async execute(dto: ExecutePromotionDto, createdById: string) {
    const validated = this.validatePayload(dto.payload);
    const shop = await this.prisma.shop.findFirst({
      where: { id: dto.shopId, brandId: dto.brandId, deletedAt: null },
      include: { brand: { include: { application: true } } },
    });
    if (!shop) throw new NotFoundException('Store was not found in the selected brand');
    if (!shop.brand.application) throw new BadRequestException('The brand has no application credentials');
    if (dto.mode === PromotionApiMode.live && !this.liveEnabled) {
      throw new BadRequestException('Live promotion uploads are disabled. Enable PROMOTIONS_API_LIVE_ENABLED only after homologation');
    }

    const execution = await this.prisma.promotionApiExecution.create({
      data: {
        brandId: dto.brandId, shopId: dto.shopId, mode: dto.mode, status: 'running', startedAt: new Date(),
        payload: validated as unknown as Prisma.InputJsonValue, createdById,
      },
    });
    const started = Date.now();
    try {
      if (dto.mode === PromotionApiMode.dry_run) {
        return await this.prisma.promotionApiExecution.update({
          where: { id: execution.id },
          data: {
            status: 'done', finishedAt: new Date(), durationMs: Date.now() - started,
            response: { valid: true, sent: false, message: 'Payload validated locally; no API request was sent' },
          },
        });
      }

      const app = shop.brand.application;
      const secret = decrypt(app.appSecret, this.encryptionKey);
      const authToken = await getAuthToken(app.appId, secret, shop.appShopId);
      const response = await fetchWithEndpointContext(ENDPOINT, URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: authToken, ...validated }),
      });
      const body = parseJsonKeepingIds(await response.text());
      if (!response.ok || body.errno !== 0) {
        throw new Error(`${ENDPOINT} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`);
      }
      const taskId = body.data?.taskID ?? body.data?.taskId;
      return await this.prisma.promotionApiExecution.update({
        where: { id: execution.id },
        data: {
          status: 'done', finishedAt: new Date(), durationMs: Date.now() - started,
          response: body as Prisma.InputJsonValue, remoteTaskId: taskId ? String(taskId) : null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.promotionApiExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', finishedAt: new Date(), durationMs: Date.now() - started, errorMessage: message.slice(0, 1500) },
      });
      throw error;
    }
  }

  async executions(page = 1) {
    const limit = 25;
    const safePage = Math.max(page, 1);
    const [data, total] = await Promise.all([
      this.prisma.promotionApiExecution.findMany({
        include: { brand: { select: { brandName: true, country: true } }, shop: { select: { shopId: true, appShopId: true, name: true } } },
        orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * limit, take: limit,
      }),
      this.prisma.promotionApiExecution.count(),
    ]);
    return { data, total, page: safePage, limit };
  }

  private validatePayload(payload: Record<string, unknown>) {
    const appItemIdType = Number(payload.app_item_id_type);
    if (![0, 1].includes(appItemIdType)) throw new BadRequestException('app_item_id_type must be 0 (app item ID) or 1 (UPC)');
    if (!Array.isArray(payload.promo_list) || payload.promo_list.length === 0 || payload.promo_list.length > 100) {
      throw new BadRequestException('promo_list must contain between 1 and 100 activities');
    }
    payload.promo_list.forEach((raw, index) => this.validateActivity(raw as PromoActivity, index));
    return { app_item_id_type: appItemIdType, promo_list: payload.promo_list };
  }

  private validateActivity(activity: PromoActivity, index: number) {
    const label = `promo_list[${index}]`;
    const action = Number(activity.action);
    if (![1, 2].includes(action)) throw new BadRequestException(`${label}.action must be 1 or 2`);
    if (typeof activity.activity_id !== 'string' && typeof activity.activity_id !== 'number') {
      throw new BadRequestException(`${label}.activity_id is required`);
    }
    if (action === 2) return;
    const type = Number(activity.activity_type);
    if (![2, 4, 8].includes(type)) throw new BadRequestException(`${label}.activity_type must be 2, 4 or 8`);
    if (typeof activity.activity_name !== 'string' || !activity.activity_name.trim()) throw new BadRequestException(`${label}.activity_name is required`);
    const start = this.parseDate(activity.start_date, `${label}.start_date`);
    const end = this.parseDate(activity.end_date, `${label}.end_date`);
    if (end <= start) throw new BadRequestException(`${label}.end_date must be after start_date`);
    if (!Array.isArray(activity.item_activity_list) || activity.item_activity_list.length === 0 || activity.item_activity_list.length > 2000) {
      throw new BadRequestException(`${label}.item_activity_list must contain between 1 and 2000 items`);
    }
    activity.item_activity_list.forEach((raw, itemIndex) => this.validateItem(raw as PromoItem, type, `${label}.item_activity_list[${itemIndex}]`));
  }

  private validateItem(item: PromoItem, type: number, label: string) {
    if (typeof item.app_item_id !== 'string' || !item.app_item_id.trim()) throw new BadRequestException(`${label}.app_item_id is required`);
    if (type === 2) {
      const percent = item.discount_perc === undefined ? null : Number(item.discount_perc);
      const amount = item.discount_amount === undefined ? null : Number(item.discount_amount);
      if (percent === null && amount === null) throw new BadRequestException(`${label} requires discount_perc or discount_amount`);
      if (percent !== null && (!Number.isInteger(percent) || percent < 5 || percent >= 100)) throw new BadRequestException(`${label}.discount_perc must be an integer from 5 to 99`);
      if (amount !== null && (!Number.isInteger(amount) || amount <= 0)) throw new BadRequestException(`${label}.discount_amount must be a positive integer in the smallest currency unit`);
    }
    if (type === 4) this.requirePositiveIntegers(item, ['buy_num', 'get_num'], label);
    if (type === 8) this.requirePositiveIntegers(item, ['bxgy_x', 'bxgy_y'], label);
  }

  private requirePositiveIntegers(item: PromoItem, fields: Array<keyof PromoItem>, label: string) {
    for (const field of fields) {
      const value = Number(item[field]);
      if (!Number.isInteger(value) || value <= 0) throw new BadRequestException(`${label}.${field} must be a positive integer`);
    }
  }

  private parseDate(value: unknown, label: string) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
      throw new BadRequestException(`${label} must use YYYY-MM-DD HH:mm:ss`);
    }
    const parsed = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${label} is not a valid date`);
    return parsed;
  }
}
