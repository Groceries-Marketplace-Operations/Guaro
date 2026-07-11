import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePoolDto } from './dto/create-pool.dto';
import { UpdatePoolDto } from './dto/update-pool.dto';

const POOL_INCLUDE = {
  webhook: { select: { id: true, name: true } },
  brands: {
    include: {
      brand: { select: { id: true, brandName: true, brandId: true, country: true } },
    },
  },
};

@Injectable()
export class AutoOpenPoolsService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('auto-open') private queue: Queue,
  ) {}

  async list() {
    return this.prisma.autoOpenPool.findMany({
      include: POOL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const pool = await this.prisma.autoOpenPool.findUnique({ where: { id }, include: POOL_INCLUDE });
    if (!pool) throw new NotFoundException('Pool not found');
    return pool;
  }

  async create(dto: CreatePoolDto) {
    const { brandIds, webhookId, ...rest } = dto;
    return this.prisma.autoOpenPool.create({
      data: {
        ...rest,
        webhook: webhookId ? { connect: { id: webhookId } } : undefined,
        brands: { create: brandIds.map(brandId => ({ brandId })) },
      },
      include: POOL_INCLUDE,
    });
  }

  async update(id: string, dto: UpdatePoolDto) {
    await this.findOne(id);
    const { brandIds, webhookId, ...rest } = dto;

    return this.prisma.$transaction(async tx => {
      if (brandIds !== undefined) {
        await tx.autoOpenPoolBrand.deleteMany({ where: { poolId: id } });
        if (brandIds.length > 0) {
          await tx.autoOpenPoolBrand.createMany({ data: brandIds.map((bId: string) => ({ poolId: id, brandId: bId })) });
        }
      }
      return tx.autoOpenPool.update({
        where: { id },
        data: {
          ...rest,
          webhook: webhookId !== undefined
            ? (webhookId ? { connect: { id: webhookId } } : { disconnect: true })
            : undefined,
        },
        include: POOL_INCLUDE,
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.autoOpenPool.delete({ where: { id } });
  }

  async runNow(id: string) {
    await this.findOne(id);
    const execution = await this.prisma.autoOpenExecution.create({
      data: { poolId: id, status: 'pending' },
    });
    await this.queue.add('run-pool', { executionId: execution.id }, { jobId: execution.id });
    return execution;
  }

  async listExecutions(poolId: string, page = 1, limit = 20) {
    await this.findOne(poolId);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.autoOpenExecution.findMany({
        where: { poolId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.autoOpenExecution.count({ where: { poolId } }),
    ]);
    return { data, total, page, limit };
  }
}
