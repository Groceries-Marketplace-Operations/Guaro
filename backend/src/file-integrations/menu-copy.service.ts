import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMenuCopyDto } from './dto/create-menu-copy.dto';

@Injectable()
export class MenuCopyService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('menu-copy') private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    await this.prisma.menuCopyExecution.updateMany({
      where: { status: { in: ['pending', 'running'] } },
      data: {
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: new Date(),
        currentStep: null,
        errorMessage: 'Interrupted by service restart',
      },
    });
  }

  list() {
    return this.prisma.menuCopyExecution.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        sourceBrand: {
          select: {
            id: true, brandId: true, brandName: true, country: true,
            application: { select: { id: true, appId: true, appName: true } },
          },
        },
        targetBrand: {
          select: {
            id: true, brandId: true, brandName: true, country: true,
            application: { select: { id: true, appId: true, appName: true } },
          },
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async create(dto: CreateMenuCopyDto, accountId: string) {
    const brands = await this.prisma.brand.findMany({
      where: { id: { in: [dto.sourceBrandId, dto.targetBrandId] }, deletedAt: null },
      select: { id: true, applicationId: true, brandName: true },
    });
    const source = brands.find(brand => brand.id === dto.sourceBrandId);
    const target = brands.find(brand => brand.id === dto.targetBrandId);
    if (!source) throw new BadRequestException('Source brand not found');
    if (!target) throw new BadRequestException('Target brand not found');
    if (!source.applicationId) throw new BadRequestException(`Source brand ${source.brandName} has no DiDi application linked`);
    if (!target.applicationId) throw new BadRequestException(`Target brand ${target.brandName} has no DiDi application linked`);
    if (source.applicationId === target.applicationId) {
      throw new BadRequestException('Source and target must belong to different DiDi applications');
    }

    const execution = await this.prisma.menuCopyExecution.create({
      data: {
        sourceBrandId: dto.sourceBrandId,
        sourceShopId: dto.sourceShopId,
        targetBrandId: dto.targetBrandId,
        targetShopId: dto.targetShopId,
        mergePolicy: dto.mergePolicy,
        currentStep: 'queued',
        createdById: accountId,
      },
    });
    try {
      await this.queue.add('copy-menu-across-apps', { executionId: execution.id }, {
        jobId: execution.id,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
      return execution;
    } catch (error) {
      await this.prisma.menuCopyExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', finishedAt: new Date(), currentStep: null, errorMessage: (error as Error).message },
      });
      throw error;
    }
  }

  async stop(id: string) {
    const result = await this.prisma.menuCopyExecution.updateMany({
      where: { id, status: { in: ['pending', 'running'] } },
      data: {
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: new Date(),
        currentStep: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This menu copy has no active execution');
    return { stopped: true };
  }
}
