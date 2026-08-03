import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { AutoFetchKind, Country, KaType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAutoFetchPoolDto } from './dto/update-auto-fetch-pool.dto';
import { nextDailyRun, nextDailyRunFromTimes, timezoneForCountry } from './auto-fetch-time.util';

@Injectable()
export class AutoFetchService implements OnModuleInit {
  private readonly logger = new Logger(AutoFetchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('auto-fetch') private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    const defaults: Array<{ kind: AutoFetchKind; country: Country; hour: number; name: string }> = [];
    for (const country of [Country.MX, Country.CO, Country.CR]) {
      defaults.push(
        { kind: AutoFetchKind.stores, country, hour: 1, name: `${country} KA Stores` },
        { kind: AutoFetchKind.menu, country, hour: 3, name: `${country} KA Menus` },
      );
    }
    for (const item of defaults) {
      const timezone = timezoneForCountry(item.country);
      await this.prisma.autoFetchPool.upsert({
        where: { kind_country: { kind: item.kind, country: item.country } },
        create: {
          kind: item.kind,
          country: item.country,
          name: item.name,
          executionHour: item.hour,
          executionTimes: item.kind === AutoFetchKind.menu ? [this.formatTime(item.hour, 0)] : [],
          timezone,
          nextRunAt: nextDailyRun(new Date(), item.hour, 0, timezone),
        },
        update: {},
      });
    }
    await this.reconcileOrphanedExecutions();
  }

  async list(kind: AutoFetchKind) {
    const [pools, brands] = await Promise.all([
      this.prisma.autoFetchPool.findMany({
        where: { kind },
        include: {
          executions: { orderBy: { createdAt: 'desc' }, take: 5 },
          brandSettings: true,
        },
        orderBy: { country: 'asc' },
      }),
      this.prisma.brand.findMany({
        where: { kaType: { in: [KaType.KA, KaType.CKA] }, deletedAt: null, applicationId: { not: null } },
        select: {
          id: true,
          brandId: true,
          brandName: true,
          country: true,
          kaType: true,
          _count: { select: { shops: { where: { deletedAt: null } }, items: true } },
        },
        orderBy: { brandName: 'asc' },
      }),
    ]);

    return pools.map(pool => {
      const settings = new Map(pool.brandSettings.map(setting => [setting.brandId, setting]));
      const countryBrands = brands.filter(brand => brand.country === pool.country);
      const kaBrands = countryBrands
        .filter(brand => brand.kaType === KaType.KA)
        .map(brand => ({
          ...brand,
          active: settings.get(brand.id)?.active ?? true,
          manuallyIncluded: false,
        }));
      const ckaBrands = countryBrands
        .filter(brand => brand.kaType === KaType.CKA && settings.get(brand.id)?.manuallyIncluded)
        .map(brand => ({
          ...brand,
          active: settings.get(brand.id)?.active ?? true,
          manuallyIncluded: true,
        }));
      const includedCkaIds = new Set(ckaBrands.map(brand => brand.id));
      const ckaCandidates = countryBrands.filter(brand => brand.kaType === KaType.CKA && !includedCkaIds.has(brand.id));
      return {
        ...pool,
        brandSettings: undefined,
        brands: [...kaBrands, ...ckaBrands],
        kaBrands,
        ckaBrands,
        ckaCandidates,
      };
    });
  }

  async update(id: string, dto: UpdateAutoFetchPoolDto) {
    const pool = await this.findOne(id);
    const hour = dto.executionHour ?? pool.executionHour;
    const minute = dto.executionMinute ?? pool.executionMinute;
    if (dto.executionTimes !== undefined && pool.kind !== AutoFetchKind.menu) {
      throw new BadRequestException('Multiple daily times are only available for Auto Menu Fetch');
    }
    const executionTimes = pool.kind === AutoFetchKind.menu
      ? this.normalizeExecutionTimes(
        dto.executionTimes
          ?? (dto.executionHour !== undefined || dto.executionMinute !== undefined
            ? [this.formatTime(hour, minute)]
            : pool.executionTimes),
      )
      : [];
    const scheduleChanged = dto.executionTimes !== undefined
      || dto.executionHour !== undefined
      || dto.executionMinute !== undefined;
    return this.prisma.autoFetchPool.update({
      where: { id },
      data: {
        active: dto.active,
        executionHour: dto.executionHour,
        executionMinute: dto.executionMinute,
        executionTimes,
        nextRunAt: scheduleChanged
          ? (pool.kind === AutoFetchKind.menu
            ? nextDailyRunFromTimes(new Date(), executionTimes, pool.timezone)
            : nextDailyRun(new Date(), hour, minute, pool.timezone))
          : undefined,
      },
    });
  }

  async addCkaBrand(poolId: string, brandId: string) {
    const { pool, brand } = await this.getPoolAndBrand(poolId, brandId);
    if (brand.kaType !== KaType.CKA) throw new BadRequestException('Only CKA brands are added manually');
    return this.prisma.autoFetchPoolBrand.upsert({
      where: { poolId_brandId: { poolId: pool.id, brandId: brand.id } },
      create: { poolId: pool.id, brandId: brand.id, active: true, manuallyIncluded: true },
      update: { active: true, manuallyIncluded: true },
    });
  }

  async removeCkaBrand(poolId: string, brandId: string) {
    await this.getPoolAndBrand(poolId, brandId);
    const setting = await this.prisma.autoFetchPoolBrand.findUnique({
      where: { poolId_brandId: { poolId, brandId } },
    });
    if (!setting?.manuallyIncluded) throw new BadRequestException('CKA brand is not included in this pool');
    await this.prisma.autoFetchPoolBrand.delete({ where: { id: setting.id } });
    return { removed: true };
  }

  async updateBrand(poolId: string, brandId: string, active: boolean) {
    const { pool, brand } = await this.getPoolAndBrand(poolId, brandId);
    const existing = await this.prisma.autoFetchPoolBrand.findUnique({
      where: { poolId_brandId: { poolId, brandId } },
    });
    if (brand.kaType === KaType.CKA && !existing?.manuallyIncluded) {
      throw new BadRequestException('Add the CKA brand to the pool before changing its status');
    }
    return this.prisma.autoFetchPoolBrand.upsert({
      where: { poolId_brandId: { poolId, brandId } },
      create: {
        poolId: pool.id,
        brandId: brand.id,
        active,
        manuallyIncluded: brand.kaType === KaType.CKA,
      },
      update: { active },
    });
  }

  async runNow(id: string) {
    return this.createExecution(id, [], 'manual');
  }

  async runBrand(poolId: string, brandId: string) {
    const { brand } = await this.getPoolAndBrand(poolId, brandId);
    if (brand.kaType === KaType.CKA) {
      const setting = await this.prisma.autoFetchPoolBrand.findUnique({
        where: { poolId_brandId: { poolId, brandId } },
      });
      if (!setting?.manuallyIncluded) throw new BadRequestException('Add the CKA brand to this pool first');
    }
    return this.createExecution(poolId, [brandId], 'manual_brand');
  }

  async stopPool(poolId: string) {
    await this.findOne(poolId);
    const execution = await this.prisma.autoFetchExecution.findFirst({
      where: { poolId, status: { in: ['pending', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!execution) throw new BadRequestException('There is no active country execution to stop');
    if (execution.status === 'pending') {
      return this.prisma.autoFetchExecution.update({
        where: { id: execution.id },
        data: {
          status: 'cancelled',
          cancelRequested: true,
          finishedAt: new Date(),
          currentBrand: null,
          errorMessage: 'Stopped manually at country level',
        },
      });
    }
    const stopped = await this.prisma.autoFetchExecution.update({
      where: { id: execution.id },
      data: { cancelRequested: true, errorMessage: 'Country stop requested; finishing the current safe operation' },
    });
    if (await this.hasActiveWorker(execution.id)) return stopped;
    return this.finishOrphanedExecution(
      execution.id,
      true,
      'Stopped manually; the queue worker was no longer active',
    );
  }

  async stopBrand(poolId: string, brandId: string) {
    await this.getPoolAndBrand(poolId, brandId);
    const execution = await this.prisma.autoFetchExecution.findFirst({
      where: { poolId, status: { in: ['pending', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!execution) throw new BadRequestException('There is no active execution for this pool');
    if (!execution.cancelledBrandIds.includes(brandId)) {
      await this.prisma.autoFetchExecution.update({
        where: { id: execution.id },
        data: { cancelledBrandIds: { push: brandId } },
      });
    }
    if (!(await this.hasActiveWorker(execution.id))) {
      await this.finishOrphanedExecution(
        execution.id,
        true,
        'Brand stop requested, but the queue worker was no longer active; execution cancelled',
      );
    }
    return { executionId: execution.id, brandId, stopRequested: true };
  }

  async executions(poolId: string, page = 1, limit = 20) {
    await this.findOne(poolId);
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await Promise.all([
      this.prisma.autoFetchExecution.findMany({
        where: { poolId },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.autoFetchExecution.count({ where: { poolId } }),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  async findOne(id: string) {
    const pool = await this.prisma.autoFetchPool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('Auto fetch pool not found');
    return pool;
  }

  private async getPoolAndBrand(poolId: string, brandId: string) {
    const [pool, brand] = await Promise.all([
      this.findOne(poolId),
      this.prisma.brand.findUnique({
        where: { id: brandId },
        select: { id: true, brandName: true, country: true, kaType: true, applicationId: true, deletedAt: true },
      }),
    ]);
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    if (brand.country !== pool.country) throw new BadRequestException('Brand and pool must belong to the same country');
    if (!brand.applicationId) throw new BadRequestException('Brand has no linked application credentials');
    if (brand.kaType !== KaType.KA && brand.kaType !== KaType.CKA) {
      throw new BadRequestException('Only KA and manually included CKA brands can use Auto Fetch');
    }
    return { pool, brand };
  }

  private async createExecution(poolId: string, requestedBrandIds: string[], trigger: string) {
    const pool = await this.findOne(poolId);
    const active = await this.prisma.autoFetchExecution.findFirst({
      where: { poolId, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (active) throw new BadRequestException('This pool already has an execution pending or running');
    const execution = await this.prisma.autoFetchExecution.create({
      data: { poolId, trigger, requestedBrandIds },
    });
    await this.queue.add(`fetch-${pool.kind}`, { executionId: execution.id }, {
      jobId: execution.id,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return execution;
  }

  private async hasActiveWorker(executionId: string) {
    const job = await this.queue.getJob(executionId);
    return job ? (await job.getState()) === 'active' : false;
  }

  private async finishOrphanedExecution(
    executionId: string,
    cancelled: boolean,
    errorMessage: string,
  ) {
    await this.prisma.autoFetchExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: {
        status: cancelled ? 'cancelled' : 'failed',
        cancelRequested: cancelled,
        finishedAt: new Date(),
        progressPercent: 100,
        currentBrand: null,
        errorMessage,
      },
    });
    return this.prisma.autoFetchExecution.findUnique({ where: { id: executionId } });
  }

  private async reconcileOrphanedExecutions() {
    const running = await this.prisma.autoFetchExecution.findMany({
      where: { status: 'running' },
      select: { id: true, cancelRequested: true },
    });
    for (const execution of running) {
      if (await this.hasActiveWorker(execution.id)) continue;
      await this.finishOrphanedExecution(
        execution.id,
        execution.cancelRequested,
        execution.cancelRequested
          ? 'Stopped manually; orphaned execution reconciled during backend startup'
          : 'Execution interrupted because its queue worker was no longer active',
      );
      this.logger.warn(`Reconciled orphaned auto fetch execution ${execution.id}`);
    }
  }

  private normalizeExecutionTimes(values: string[]) {
    const normalized = [...new Set(values.map(value => value.trim()))].sort();
    if (normalized.length === 0) throw new BadRequestException('At least one daily execution time is required');
    if (normalized.length > 24) throw new BadRequestException('A maximum of 24 daily execution times is allowed');
    if (normalized.some(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      throw new BadRequestException('Execution times must use HH:mm format');
    }
    return normalized;
  }

  private formatTime(hour: number, minute: number) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
}
