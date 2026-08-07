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
        sourceApplication: { select: { id: true, appId: true, appName: true, country: true } },
        targetApplication: { select: { id: true, appId: true, appName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async create(dto: CreateMenuCopyDto, accountId: string) {
    const applications = await this.prisma.application.findMany({
      where: { id: { in: [dto.sourceApplicationId, dto.targetApplicationId] }, deletedAt: null },
      select: { id: true, appName: true },
    });
    const source = applications.find(application => application.id === dto.sourceApplicationId);
    const target = applications.find(application => application.id === dto.targetApplicationId);
    if (!source) throw new BadRequestException('Source application not found');
    if (!target) throw new BadRequestException('Target application not found');
    if (source.id === target.id) throw new BadRequestException('Source and target applications must be different');

    const execution = await this.prisma.menuCopyExecution.create({
      data: {
        sourceApplicationId: dto.sourceApplicationId,
        sourceShopId: dto.sourceShopId,
        targetApplicationId: dto.targetApplicationId,
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
