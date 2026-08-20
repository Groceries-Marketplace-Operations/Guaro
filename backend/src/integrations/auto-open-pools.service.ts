import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Country, KaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSenderService } from '../webhooks/webhook-sender.service';
import { CreatePoolDto } from './dto/create-pool.dto';
import { UpdatePoolDto } from './dto/update-pool.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { ListAutoOpenStoresDto } from './dto/list-auto-open-stores.dto';
import {
  AutoOpenSelectionService,
  autoOpenPoolBrandSummaryKey,
  emptyAutoOpenStoreSummary,
} from './auto-open-selection.service';

const POOL_INCLUDE = {
  webhook: { select: { id: true, name: true } },
  brands: {
    where: { brand: { deletedAt: null } },
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
    private readonly selection: AutoOpenSelectionService,
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
        await this.lockPoolForUpdate(tx, pool.id);
        const lockedPool = await tx.autoOpenPool.findUnique({
          where: { id: pool.id },
          select: {
            brands: { select: { brandId: true } },
            brandExclusions: { select: { brandId: true } },
          },
        });
        if (!lockedPool) throw new NotFoundException('Auto Open pool not found');
        const brands = await tx.brand.findMany({
          where: { country: definition.country, kaType: KaType.KA, deletedAt: null },
          select: { id: true },
        });
        const excludedBrandIds = new Set(
          lockedPool.brandExclusions.map(exclusion => exclusion.brandId),
        );
        const brandIds = brands
          .map(brand => brand.id)
          .filter(brandId => !excludedBrandIds.has(brandId));
        const desiredBrandIds = new Set(brandIds);
        const currentBrandIds = new Set(
          lockedPool.brands.map(association => association.brandId),
        );
        const membershipChanged = desiredBrandIds.size !== currentBrandIds.size
          || brandIds.some(brandId => !currentBrandIds.has(brandId));
        if (membershipChanged) {
          const activeExecution = await tx.autoOpenExecution.findFirst({
            where: { poolId: pool.id, status: { in: ['pending', 'running'] } },
            select: { id: true },
          });
          if (activeExecution) return;
        }
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
    const pools = await this.prisma.autoOpenPool.findMany({
      include: POOL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    const summaries = await this.selection.summarizePools(pools.map(pool => pool.id));
    return pools.map(pool => ({
      ...pool,
      storeSummary: summaries.byPool.get(pool.id)
        ?? emptyAutoOpenStoreSummary(summaries.calculatedAt),
      brands: pool.brands.map(association => ({
        ...association,
        storeSummary: summaries.byPoolBrand.get(
          autoOpenPoolBrandSummaryKey(pool.id, association.brandId),
        ) ?? emptyAutoOpenStoreSummary(summaries.calculatedAt),
      })),
    }));
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
    if (dto.timezone !== undefined) this.assertTimezone(dto.timezone);

    const {
      brandIds,
      includeBrandIds,
      excludeBrandIds,
      webhookId,
      country,
      ...rest
    } = dto;
    const hasManagedBrandDelta = includeBrandIds !== undefined || excludeBrandIds !== undefined;
    return this.prisma.$transaction(async tx => {
      await this.lockPoolForUpdate(tx, id);
      const existing = await tx.autoOpenPool.findUnique({
        where: { id },
        include: POOL_INCLUDE,
      });
      if (!existing) throw new NotFoundException('Auto Open pool not found');

      const nextDryRun = dto.dryRun ?? existing.dryRun;
      const nextActive = dto.active ?? existing.active;
      if (nextActive && !nextDryRun && !this.remoteWritesEnabled()) {
        throw new BadRequestException(
          'Live Auto Open is disabled on this server. Enable AUTO_OPEN_REMOTE_WRITE_ENABLED only after a dry-run review.',
        );
      }

      if (existing.managedKey) {
        if (brandIds !== undefined) {
          throw new ConflictException(
            'Managed KA pool membership requires includeBrandIds/excludeBrandIds deltas; reload the pool before saving',
          );
        }
        if (hasManagedBrandDelta) {
          const included = [...new Set(includeBrandIds ?? [])];
          const excluded = [...new Set(excludeBrandIds ?? [])];
          const includedSet = new Set(included);
          const overlap = excluded.filter(brandId => includedSet.has(brandId));
          if (overlap.length) {
            throw new BadRequestException(
              `A brand cannot be both included and excluded: ${overlap.join(', ')}`,
            );
          }
          const touchedBrandIds = [...included, ...excluded];
          if (touchedBrandIds.length) {
            const eligibleBrands = await tx.brand.findMany({
              where: {
                id: { in: touchedBrandIds },
                country: existing.country,
                kaType: KaType.KA,
                deletedAt: null,
              },
              select: { id: true },
            });
            const eligibleBrandIds = new Set(eligibleBrands.map(brand => brand.id));
            const invalidBrandIds = touchedBrandIds.filter(brandId => !eligibleBrandIds.has(brandId));
            if (invalidBrandIds.length) {
              throw new BadRequestException(
                `Managed KA pools can only change active KA brands from ${existing.country}: ${invalidBrandIds.join(', ')}`,
              );
            }
          }
          const [currentMemberships, currentExclusions] = touchedBrandIds.length
            ? await Promise.all([
              tx.autoOpenPoolBrand.findMany({
                where: { poolId: id, brandId: { in: touchedBrandIds } },
                select: { brandId: true },
              }),
              tx.autoOpenPoolBrandExclusion.findMany({
                where: { poolId: id, brandId: { in: touchedBrandIds } },
                select: { brandId: true },
              }),
            ])
            : [[], []];
          const currentMembershipIds = new Set(currentMemberships.map(value => value.brandId));
          const currentExclusionIds = new Set(currentExclusions.map(value => value.brandId));
          const actualIncluded = included.filter(brandId => (
            !currentMembershipIds.has(brandId) || currentExclusionIds.has(brandId)
          ));
          const actualExcluded = excluded.filter(brandId => (
            currentMembershipIds.has(brandId) || !currentExclusionIds.has(brandId)
          ));
          if (actualIncluded.length || actualExcluded.length) {
            await this.assertNoActiveMembershipChange(tx, id);
          }
          if (actualIncluded.length) {
            await tx.autoOpenPoolBrandExclusion.deleteMany({
              where: { poolId: id, brandId: { in: actualIncluded } },
            });
            await tx.autoOpenPoolBrand.createMany({
              data: actualIncluded.map(brandId => ({ poolId: id, brandId })),
              skipDuplicates: true,
            });
          }
          if (actualExcluded.length) {
            await tx.autoOpenPoolBrandExclusion.createMany({
              data: actualExcluded.map(brandId => ({ poolId: id, brandId })),
              skipDuplicates: true,
            });
            await tx.autoOpenPoolBrand.deleteMany({
              where: { poolId: id, brandId: { in: actualExcluded } },
            });
          }
        }
      } else {
        if (hasManagedBrandDelta) {
          throw new BadRequestException(
            'Custom pools require brandIds replacement and do not accept managed membership deltas',
          );
        }
        if (brandIds !== undefined) {
          const desiredBrandIds = [...new Set(brandIds)];
          const currentMemberships = await tx.autoOpenPoolBrand.findMany({
            where: { poolId: id },
            select: { brandId: true },
          });
          const currentBrandIds = new Set(currentMemberships.map(value => value.brandId));
          const membershipChanged = desiredBrandIds.length !== currentBrandIds.size
            || desiredBrandIds.some(brandId => !currentBrandIds.has(brandId));
          if (membershipChanged) {
            await this.assertNoActiveMembershipChange(tx, id);
            await tx.autoOpenPoolBrand.deleteMany({ where: { poolId: id } });
            if (desiredBrandIds.length > 0) {
              await tx.autoOpenPoolBrand.createMany({
                data: desiredBrandIds.map(brandId => ({ poolId: id, brandId })),
                skipDuplicates: true,
              });
            }
          }
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

  private async lockPoolForUpdate(tx: Prisma.TransactionClient, poolId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "auto_open_pool"
      WHERE "id" = ${poolId}::uuid
      FOR UPDATE
    `);
    if (!rows.length) throw new NotFoundException('Auto Open pool not found');
  }

  private async assertNoActiveMembershipChange(
    tx: Prisma.TransactionClient,
    poolId: string,
  ) {
    const activeExecution = await tx.autoOpenExecution.findFirst({
      where: { poolId, status: { in: ['pending', 'running'] } },
      select: { id: true, status: true },
    });
    if (activeExecution) {
      throw new ConflictException(
        `Pool brands cannot change while Auto Open execution ${activeExecution.id} is ${activeExecution.status}; wait for it to finish and try again`,
      );
    }
  }

  async remove(id: string) {
    const pool = await this.findOne(id);
    if (pool.managedKey) throw new BadRequestException('Managed KA pools cannot be deleted; deactivate them instead');
    return this.prisma.autoOpenPool.delete({ where: { id } });
  }

  async runNow(id: string) {
    await this.ensureManagedKaPools();
    const execution = await this.createPendingExecution(id, null, false);
    if (!execution) throw new Error('Manual Auto Open execution was unexpectedly skipped');
    return this.enqueueExecution(execution);
  }

  async runScheduled(id: string, scheduledSlot: Date) {
    try {
      const execution = await this.createPendingExecution(id, scheduledSlot, true);
      return execution ? await this.enqueueExecution(execution) : null;
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

  async listStores(poolId: string, query: ListAutoOpenStoresDto) {
    await this.findOne(poolId);
    return this.selection.listPoolStores(poolId, query);
  }

  private async createPendingExecution(
    poolId: string,
    scheduledSlot: Date | null,
    skipIfActive: boolean,
  ) {
    return this.prisma.$transaction(async tx => {
      await this.lockPoolForUpdate(tx, poolId);
      const pool = await tx.autoOpenPool.findUnique({
        where: { id: poolId },
        select: { id: true, active: true, dryRun: true },
      });
      if (!pool) throw new NotFoundException('Auto Open pool not found');
      if (scheduledSlot && !pool.active) return null;

      const remoteWritesEnabled = !pool.dryRun && this.remoteWritesEnabled();
      if (!pool.dryRun && !remoteWritesEnabled) {
        throw new BadRequestException('Live Auto Open is disabled on this server');
      }
      const active = await tx.autoOpenExecution.findFirst({
        where: { poolId, status: { in: ['pending', 'running'] } },
        select: { id: true, status: true },
      });
      if (active) {
        if (skipIfActive) return null;
        throw new BadRequestException(
          `Auto Open pool already has an active ${active.status} execution: ${active.id}`,
        );
      }
      return tx.autoOpenExecution.create({
        data: {
          poolId,
          status: 'pending',
          dryRun: pool.dryRun,
          remoteWritesEnabled,
          scheduledSlot,
        },
      });
    });
  }

  private async enqueueExecution<T extends { id: string }>(execution: T): Promise<T> {
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
