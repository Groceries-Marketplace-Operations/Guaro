import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { decrypt } from '../common/crypto.util';
import {
  DIDI_BASE,
  BATCH_SIZE,
  COOLDOWN_BATCH_MS,
  getAuthToken,
  parseJsonKeepingIds,
  sleep,
} from '../queue/handlers/didi-food.util';

interface BrandLog {
  brandName: string;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  blockedByEmergency?: boolean;
  error?: string;
}

const LIVE_EMERGENCY_STATUSES = ['pending', 'running', 'offline', 'partial_success', 'restoring'];

export function isOpenable(bizStatus: number, subBizStatus: number): boolean {
  return bizStatus === 2 && [3, 5, 7].includes(subBizStatus);
}

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

async function getShopStatus(authToken: string): Promise<{ bizStatus: number; subBizStatus: number } | null> {
  try {
    const response = await fetch(`${DIDI_BASE}/v1/shop/shop/detail?auth_token=${authToken}`);
    const body = parseJsonKeepingIds(await response.text());
    if (body.errno !== 0 || !body.data) return null;
    return { bizStatus: body.data.biz_status, subBizStatus: body.data.sub_biz_status };
  } catch {
    return null;
  }
}

async function openShop(authToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${DIDI_BASE}/v1/shop/shop/setStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, biz_status: 1, auto_switch: 3 }),
    });
    const body = parseJsonKeepingIds(await response.text());
    return body.errno === 0;
  } catch {
    return false;
  }
}

@Processor('auto-open', { concurrency: 1 })
export class AutoOpenProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoOpenProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhookSenderService,
  ) {
    super();
  }

  async process(job: Job<{ executionId: string }>): Promise<void> {
    const { executionId } = job.data;
    const claimed = await this.prisma.autoOpenExecution.updateMany({
      where: { id: executionId, status: 'pending' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Auto Open execution ${executionId} was already claimed or completed`);
      return;
    }

    try {
      await this.execute(executionId);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Auto Open execution ${executionId} failed: ${message}`);
      await this.prisma.autoOpenExecution.updateMany({
        where: { id: executionId, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), logs: { error: message } },
      });
      throw error;
    }
  }

  private async execute(executionId: string) {
    const execution = await this.prisma.autoOpenExecution.findUnique({
      where: { id: executionId },
      include: {
        pool: {
          include: {
            brands: {
              include: {
                brand: {
                  include: {
                    application: { select: { appId: true, appSecret: true } },
                    shops: { where: { deletedAt: null }, select: { id: true, appShopId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!execution) throw new Error(`Execution ${executionId} not found`);

    const serverWritesEnabled = this.config.get<string>('AUTO_OPEN_REMOTE_WRITE_ENABLED')?.trim().toLowerCase() === 'true';
    if (!execution.dryRun && (!execution.remoteWritesEnabled || !serverWritesEnabled)) {
      throw new Error('Live Auto Open was stopped because remote writes are disabled on this server');
    }

    const encKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
    const brandLogs: BrandLog[] = [];
    let totalShops = 0;
    let totalOpened = 0;
    let totalWouldOpen = 0;
    let totalSkippedEmergency = 0;

    const brandIds = execution.pool.brands.map(item => item.brand.id);
    const liveEmergencies = brandIds.length > 0
      ? await this.prisma.storeEmergency.findMany({
        where: { brandId: { in: brandIds }, status: { in: LIVE_EMERGENCY_STATUSES }, finishedAt: null },
        select: { brandId: true, mode: true, targets: { select: { shopId: true } } },
      })
      : [];
    const { blockedBrands, blockedShopsByBrand } = buildEmergencyProtection(liveEmergencies);

    for (const { brand } of execution.pool.brands) {
      const emptyLog = { shopsProcessed: 0, shopsOpened: 0, shopsWouldOpen: 0, shopsSkippedEmergency: 0 };
      if (!brand.application) {
        brandLogs.push({ brandName: brand.brandName, ...emptyLog, error: 'No application linked' });
        continue;
      }
      if (blockedBrands.has(brand.id)) {
        totalSkippedEmergency += brand.shops.length;
        brandLogs.push({
          brandName: brand.brandName,
          ...emptyLog,
          shopsSkippedEmergency: brand.shops.length,
          blockedByEmergency: true,
        });
        continue;
      }

      const blockedShopIds = blockedShopsByBrand.get(brand.id) ?? new Set<string>();
      let shopsSkippedEmergency = brand.shops.filter(shop => blockedShopIds.has(shop.id)).length;
      const shops = brand.shops.filter(shop => !blockedShopIds.has(shop.id));
      totalSkippedEmergency += shopsSkippedEmergency;
      let shopsProcessed = 0;
      let shopsOpened = 0;
      let shopsWouldOpen = 0;

      try {
        const appId = brand.application.appId;
        const appSecret = encKey ? decrypt(brand.application.appSecret, encKey) : brand.application.appSecret;
        for (let index = 0; index < shops.length; index += BATCH_SIZE) {
          const batch = shops.slice(index, index + BATCH_SIZE);
          const tokens: Array<{ shopUuid: string; appShopId: string; token: string }> = [];
          for (const shop of batch) {
            try {
              tokens.push({
                shopUuid: shop.id,
                appShopId: shop.appShopId,
                token: await getAuthToken(appId, appSecret, shop.appShopId),
              });
            } catch {
              this.logger.warn(`Could not obtain token for Auto Open shop ${shop.appShopId}`);
            }
          }

          for (const item of tokens) {
            const status = await getShopStatus(item.token);
            if (!status) continue;
            shopsProcessed++;
            if (!isOpenable(status.bizStatus, status.subBizStatus)) continue;
            if (await this.hasLiveEmergency(item.shopUuid)) {
              shopsSkippedEmergency++;
              totalSkippedEmergency++;
              this.logger.warn(`Skipped Auto Open shop ${item.appShopId}: protected by a live emergency`);
              continue;
            }
            shopsWouldOpen++;
            if (!execution.dryRun && await openShop(item.token)) {
              shopsOpened++;
              this.logger.log(`Opened shop ${item.appShopId} (brand: ${brand.brandName})`);
            }
          }
          if (index + BATCH_SIZE < shops.length) await sleep(COOLDOWN_BATCH_MS);
        }
        brandLogs.push({ brandName: brand.brandName, shopsProcessed, shopsOpened, shopsWouldOpen, shopsSkippedEmergency });
      } catch (error) {
        brandLogs.push({
          brandName: brand.brandName,
          shopsProcessed,
          shopsOpened,
          shopsWouldOpen,
          shopsSkippedEmergency,
          error: (error as Error).message,
        });
      }
      totalShops += shopsProcessed;
      totalOpened += shopsOpened;
      totalWouldOpen += shopsWouldOpen;
    }

    await this.prisma.autoOpenExecution.update({
      where: { id: executionId },
      data: {
        status: brandLogs.some(log => log.error) ? 'partial_success' : 'done',
        finishedAt: new Date(),
        totalShops,
        shopsOpened: totalOpened,
        shopsWouldOpen: totalWouldOpen,
        shopsSkippedEmergency: totalSkippedEmergency,
        logs: {
          mode: execution.dryRun ? 'dry_run' : 'live',
          brands: brandLogs,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    if (execution.pool.webhookId) {
      await this.webhooks.sendToWebhook(execution.pool.webhookId, {
        text: `${execution.dryRun ? '🧪' : '🟢'} **Auto Open Stores — ${execution.pool.name}** (${execution.pool.country})`,
        attachments: [{
          title: execution.dryRun ? 'Dry-run complete — no stores were changed' : 'Live execution complete',
          text: [
            `**Shops processed:** ${totalShops}`,
            `**Would open:** ${totalWouldOpen}`,
            `**Actually opened:** ${totalOpened}`,
            `**Protected by emergencies:** ${totalSkippedEmergency}`,
          ].join('\n'),
          color: execution.dryRun ? '#2D9CDB' : '#00C853',
        }],
      });
    }
    this.logger.log(
      `Auto Open ${executionId} ${execution.dryRun ? 'dry-run' : 'live'} done: ` +
      `${totalOpened} opened, ${totalWouldOpen} openable, ${totalSkippedEmergency} protected`,
    );
  }

  private async hasLiveEmergency(shopUuid: string) {
    const target = await this.prisma.storeEmergencyTarget.findFirst({
      where: {
        shopId: shopUuid,
        emergency: { status: { in: LIVE_EMERGENCY_STATUSES }, finishedAt: null },
      },
      select: { id: true },
    });
    return target !== null;
  }
}
