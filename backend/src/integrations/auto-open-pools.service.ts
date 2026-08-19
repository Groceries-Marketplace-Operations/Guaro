import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Country, KaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { CreatePoolDto } from './dto/create-pool.dto';
import { UpdatePoolDto } from './dto/update-pool.dto';
import { SendNotificationDto } from './dto/send-notification.dto';

const POOL_INCLUDE = {
  webhook: { select: { id: true, name: true } },
  brands: {
    include: {
      brand: { select: { id: true, brandName: true, brandId: true, country: true } },
    },
  },
} satisfies Prisma.AutoOpenPoolInclude;

const MANAGED_KA_POOLS = [
  { key: 'ka-MX', name: 'KA Auto Open — Mexico', country: Country.MX },
  { key: 'ka-CO', name: 'KA Auto Open — Colombia', country: Country.CO },
  { key: 'ka-CR', name: 'KA Auto Open — Costa Rica', country: Country.CR },
] as const;

export const AUTO_OPEN_NOTIFICATION_WEBHOOK_ID = 'a0700000-0000-4000-8000-000000000001';

@Injectable()
export class AutoOpenPoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookSender: WebhookSenderService,
    private readonly config: ConfigService,
    @InjectQueue('auto-open') private readonly queue: Queue,
  ) {}

  remoteWritesEnabled() {
    return this.config.get<string>('AUTO_OPEN_REMOTE_WRITE_ENABLED')?.trim().toLowerCase() === 'true';
  }

  capabilities() {
    const remoteWritesEnabled = this.remoteWritesEnabled();
    return {
      dryRunAvailable: true,
      remoteWritesEnabled,
      liveModeAvailable: remoteWritesEnabled,
      reason: remoteWritesEnabled
        ? 'The server remote-write gate is enabled. Each pool must still be explicitly switched out of dry-run.'
        : 'Live Auto Open is disabled on this server. AUTO_OPEN_REMOTE_WRITE_ENABLED must be enabled after reviewing a dry-run.',
    };
  }

  async ensureManagedKaPools() {
    for (const definition of MANAGED_KA_POOLS) {
      await this.prisma.$transaction(async tx => {
        const pool = await tx.autoOpenPool.upsert({
          where: { managedKey: definition.key },
          create: {
            managedKey: definition.key,
            name: definition.name,
            country: definition.country,
            active: false,
            dryRun: true,
            executionHours: [3, 9, 15, 21],
            timezone: 'America/Mexico_City',
            webhook: { connect: { id: AUTO_OPEN_NOTIFICATION_WEBHOOK_ID } },
          },
          update: { webhook: { connect: { id: AUTO_OPEN_NOTIFICATION_WEBHOOK_ID } } },
          select: { id: true },
        });
        const brands = await tx.brand.findMany({
          where: { country: definition.country, kaType: KaType.KA, deletedAt: null },
          select: { id: true },
        });
        const brandIds = brands.map(brand => brand.id);
        await tx.autoOpenPoolBrand.deleteMany({
          where: {
            poolId: pool.id,
            ...(brandIds.length > 0 ? { brandId: { notIn: brandIds } } : {}),
          },
        });
        if (brandIds.length > 0) {
          await tx.autoOpenPoolBrand.createMany({
            data: brandIds.map(brandId => ({ poolId: pool.id, brandId })),
            skipDuplicates: true,
          });
        }
      });
    }
  }

  async list() {
    await this.ensureManagedKaPools();
    return this.prisma.autoOpenPool.findMany({ include: POOL_INCLUDE, orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const pool = await this.prisma.autoOpenPool.findUnique({ where: { id }, include: POOL_INCLUDE });
    if (!pool) throw new NotFoundException('Auto Open pool not found');
    return pool;
  }

  async create(dto: CreatePoolDto) {
    this.assertTimezone(dto.timezone ?? 'America/Mexico_City');
    const { brandIds, webhookId, dryRun, ...rest } = dto;
    return this.prisma.autoOpenPool.create({
      data: {
        ...rest,
        active: false,
        dryRun: dryRun ?? true,
        webhook: webhookId ? { connect: { id: webhookId } } : undefined,
        brands: { create: brandIds.map(brandId => ({ brandId })) },
      },
      include: POOL_INCLUDE,
    });
  }

  async update(id: string, dto: UpdatePoolDto) {
    const existing = await this.findOne(id);
    const nextDryRun = dto.dryRun ?? existing.dryRun;
    const nextActive = dto.active ?? existing.active;
    if (nextActive && !nextDryRun && !this.remoteWritesEnabled()) {
      throw new BadRequestException(
        'Live Auto Open is disabled on this server. Enable AUTO_OPEN_REMOTE_WRITE_ENABLED only after a dry-run review.',
      );
    }
    if (dto.timezone !== undefined) this.assertTimezone(dto.timezone);

    const { brandIds, webhookId, country, ...rest } = dto;
    return this.prisma.$transaction(async tx => {
      if (!existing.managedKey && brandIds !== undefined) {
        await tx.autoOpenPoolBrand.deleteMany({ where: { poolId: id } });
        if (brandIds.length > 0) {
          await tx.autoOpenPoolBrand.createMany({
            data: brandIds.map(brandId => ({ poolId: id, brandId })),
            skipDuplicates: true,
          });
        }
      }
      return tx.autoOpenPool.update({
        where: { id },
        data: {
          ...rest,
          ...(!existing.managedKey && country !== undefined ? { country } : {}),
          webhook: webhookId !== undefined
            ? (webhookId ? { connect: { id: webhookId } } : { disconnect: true })
            : undefined,
        },
        include: POOL_INCLUDE,
      });
    });
  }

  async remove(id: string) {
    const pool = await this.findOne(id);
    if (pool.managedKey) throw new BadRequestException('Managed KA pools cannot be deleted; deactivate them instead');
    return this.prisma.autoOpenPool.delete({ where: { id } });
  }

  async runNow(id: string) {
    await this.ensureManagedKaPools();
    const pool = await this.findOne(id);
    const active = await this.prisma.autoOpenExecution.findFirst({
      where: { poolId: id, status: { in: ['pending', 'running'] } },
      select: { id: true, status: true },
    });
    if (active) {
      throw new BadRequestException(`Auto Open pool already has an active ${active.status} execution: ${active.id}`);
    }
    return this.enqueue(pool, null);
  }

  async runScheduled(id: string, scheduledSlot: Date) {
    try {
      const active = await this.prisma.autoOpenExecution.findFirst({
        where: { poolId: id, status: { in: ['pending', 'running'] } },
        select: { id: true },
      });
      if (active) return null;
      return await this.enqueue(await this.findOne(id), scheduledSlot);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  async sendNotification(dto: SendNotificationDto) {
    const webhooks = await this.prisma.webhook.findMany({
      where: { id: { in: dto.webhookIds } },
      select: { id: true, name: true },
    });
    const payload = {
      text: dto.title ? `**${dto.title}**` : dto.message,
      ...(dto.title ? { attachments: [{ text: dto.message, ...(dto.color ? { color: dto.color } : {}) }] } : {}),
    };
    await Promise.allSettled(webhooks.map(webhook => this.webhookSender.sendToWebhook(webhook.id, payload)));
    return { sent: webhooks.length, webhooks: webhooks.map(webhook => webhook.name) };
  }

  async listExecutions(poolId: string, page = 1, limit = 20) {
    await this.findOne(poolId);
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await Promise.all([
      this.prisma.autoOpenExecution.findMany({
        where: { poolId },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { brandRuns: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      }),
      this.prisma.autoOpenExecution.count({ where: { poolId } }),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  private async enqueue(pool: Awaited<ReturnType<AutoOpenPoolsService['findOne']>>, scheduledSlot: Date | null) {
    const remoteWritesEnabled = !pool.dryRun && this.remoteWritesEnabled();
    if (!pool.dryRun && !remoteWritesEnabled) throw new BadRequestException('Live Auto Open is disabled on this server');
    const execution = await this.prisma.autoOpenExecution.create({
      data: { poolId: pool.id, status: 'pending', dryRun: pool.dryRun, remoteWritesEnabled, scheduledSlot },
    });
    try {
      await this.queue.add('prepare-pool', { executionId: execution.id }, {
        jobId: `auto-open-prepare-${execution.id}`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    } catch (error) {
      await this.prisma.autoOpenExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', finishedAt: new Date(), logs: { error: `Queue error: ${(error as Error).message}` } },
      });
      throw error;
    }
    return execution;
  }

  private assertTimezone(timezone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException(`Invalid timezone: ${timezone}`);
    }
  }
}
