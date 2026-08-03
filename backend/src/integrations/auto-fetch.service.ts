import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { AutoFetchKind, Country } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAutoFetchPoolDto } from './dto/update-auto-fetch-pool.dto';
import { nextDailyRun, timezoneForCountry } from './auto-fetch-time.util';

@Injectable()
export class AutoFetchService implements OnModuleInit {
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
          timezone,
          nextRunAt: nextDailyRun(new Date(), item.hour, 0, timezone),
        },
        update: {},
      });
    }
  }

  async list(kind: AutoFetchKind) {
    const pools = await this.prisma.autoFetchPool.findMany({
      where: { kind },
      include: { executions: { orderBy: { createdAt: 'desc' }, take: 5 } },
      orderBy: { country: 'asc' },
    });
    const brands = await this.prisma.brand.findMany({
      where: { kaType: 'KA', deletedAt: null, applicationId: { not: null } },
      select: {
        id: true, brandId: true, brandName: true, country: true,
        _count: { select: { shops: { where: { deletedAt: null } }, items: true } },
      },
      orderBy: { brandName: 'asc' },
    });
    return pools.map(pool => ({ ...pool, brands: brands.filter(brand => brand.country === pool.country) }));
  }

  async update(id: string, dto: UpdateAutoFetchPoolDto) {
    const pool = await this.findOne(id);
    const hour = dto.executionHour ?? pool.executionHour;
    const minute = dto.executionMinute ?? pool.executionMinute;
    return this.prisma.autoFetchPool.update({
      where: { id },
      data: {
        active: dto.active,
        executionHour: dto.executionHour,
        executionMinute: dto.executionMinute,
        nextRunAt: dto.executionHour !== undefined || dto.executionMinute !== undefined
          ? nextDailyRun(new Date(), hour, minute, pool.timezone)
          : undefined,
      },
    });
  }

  async runNow(id: string) {
    const pool = await this.findOne(id);
    const active = await this.prisma.autoFetchExecution.findFirst({
      where: { poolId: id, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (active) throw new BadRequestException('This pool already has an execution pending or running');
    const execution = await this.prisma.autoFetchExecution.create({
      data: { poolId: id, trigger: 'manual' },
    });
    await this.queue.add(`fetch-${pool.kind}`, { executionId: execution.id }, {
      jobId: execution.id,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return execution;
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
}
