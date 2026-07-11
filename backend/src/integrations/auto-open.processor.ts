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
  error?: string;
}

// Criteria: shop is offline but in an openable sub-state
function isOpenable(bizStatus: number, subBizStatus: number): boolean {
  return bizStatus === 2 && [3, 5, 7].includes(subBizStatus);
}

async function getShopStatus(authToken: string): Promise<{ bizStatus: number; subBizStatus: number } | null> {
  try {
    const res = await fetch(`${DIDI_BASE}/v1/shop/shop/detail?auth_token=${authToken}`);
    const body = parseJsonKeepingIds(await res.text());
    if (body.errno !== 0 || !body.data) return null;
    return { bizStatus: body.data.biz_status, subBizStatus: body.data.sub_biz_status };
  } catch {
    return null;
  }
}

async function openShop(authToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${DIDI_BASE}/v1/shop/shop/setStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, biz_status: 1, auto_switch: 3 }),
    });
    const body = parseJsonKeepingIds(await res.text());
    return body.errno === 0;
  } catch {
    return false;
  }
}

@Processor('auto-open', { concurrency: 1 })
export class AutoOpenProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoOpenProcessor.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private webhooks: WebhookSenderService,
  ) {
    super();
  }

  async process(job: Job<{ executionId: string }>): Promise<void> {
    const { executionId } = job.data;
    this.logger.log(`Auto-open execution ${executionId} started`);

    await this.prisma.autoOpenExecution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt: new Date() },
    });

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
                    shops: { where: { deletedAt: null }, select: { appShopId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!execution) {
      this.logger.error(`Execution ${executionId} not found`);
      return;
    }

    const encKey = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
    const brandLogs: BrandLog[] = [];
    let totalShops = 0;
    let totalOpened = 0;

    for (const { brand } of execution.pool.brands) {
      if (!brand.application) {
        brandLogs.push({ brandName: brand.brandName, shopsProcessed: 0, shopsOpened: 0, error: 'No application linked' });
        continue;
      }

      const appId = brand.application.appId;
      const appSecret = encKey ? decrypt(brand.application.appSecret, encKey) : brand.application.appSecret;
      const shops = brand.shops;

      if (shops.length === 0) {
        brandLogs.push({ brandName: brand.brandName, shopsProcessed: 0, shopsOpened: 0 });
        continue;
      }

      let shopsOpened = 0;
      let shopsProcessed = 0;

      try {
        for (let i = 0; i < shops.length; i += BATCH_SIZE) {
          const batch = shops.slice(i, i + BATCH_SIZE);

          const tokensAndShops: Array<{ appShopId: string; token: string }> = [];

          for (const shop of batch) {
            try {
              const token = await getAuthToken(appId, appSecret, shop.appShopId);
              tokensAndShops.push({ appShopId: shop.appShopId, token });
            } catch {
              // skip shop if token fails
            }
          }

          for (const { appShopId, token } of tokensAndShops) {
            const status = await getShopStatus(token);
            if (!status) continue;
            shopsProcessed++;
            if (isOpenable(status.bizStatus, status.subBizStatus)) {
              const opened = await openShop(token);
              if (opened) {
                shopsOpened++;
                this.logger.log(`Opened shop ${appShopId} (brand: ${brand.brandName})`);
              }
            }
          }

          if (i + BATCH_SIZE < shops.length) await sleep(COOLDOWN_BATCH_MS);
        }

        brandLogs.push({ brandName: brand.brandName, shopsProcessed, shopsOpened });
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`Brand ${brand.brandName} failed: ${msg}`);
        brandLogs.push({ brandName: brand.brandName, shopsProcessed, shopsOpened, error: msg });
      }

      totalShops += shopsProcessed;
      totalOpened += shopsOpened;
    }

    await this.prisma.autoOpenExecution.update({
      where: { id: executionId },
      data: {
        status: 'done',
        finishedAt: new Date(),
        totalShops,
        shopsOpened: totalOpened,
        logs: { brands: brandLogs } as unknown as Prisma.InputJsonValue,
      },
    });

    // Send webhook if pool has one configured
    if (execution.pool.webhookId) {
      const pool = execution.pool;
      await this.webhooks.sendToWebhook(execution.pool.webhookId, {
        text: `🟢 **Auto Open Stores — ${pool.name}** (${pool.country})`,
        attachments: [
          {
            title: `Execution complete`,
            text: [
              `**Shops processed:** ${totalShops}`,
              `**Shops opened:** ${totalOpened}`,
              '',
              ...brandLogs.map(b =>
                b.error
                  ? `❌ ${b.brandName}: ${b.error}`
                  : `✅ ${b.brandName}: ${b.shopsOpened}/${b.shopsProcessed} opened`,
              ),
            ].join('\n'),
            color: totalOpened > 0 ? '#00C853' : '#9E9E9E',
          },
        ],
      });
    }

    this.logger.log(`Auto-open execution ${executionId} done — opened ${totalOpened}/${totalShops}`);
  }
}
