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
      take: 500,
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

    const targetShopIds = [...new Set([
      ...(dto.targetShopIds ?? []),
      ...(dto.targetShopId ? [dto.targetShopId] : []),
    ])];
    if (!targetShopIds.length) throw new BadRequestException('At least one target shop_id is required');
    if (targetShopIds.length > 500) throw new BadRequestException('A menu copy can include at most 500 target shop_id values');
    if (dto.sourceApplicationId === dto.targetApplicationId && targetShopIds.includes(dto.sourceShopId)) {
      throw new BadRequestException('The source shop cannot also be a target when both use the same application');
    }

    const executions = await this.prisma.$transaction(targetShopIds.map(targetShopId =>
      this.prisma.menuCopyExecution.create({
        data: {
          sourceApplicationId: dto.sourceApplicationId,
          sourceShopId: dto.sourceShopId,
          targetApplicationId: dto.targetApplicationId,
          targetShopId,
          mergePolicy: dto.mergePolicy,
          uploadEndpoint: dto.uploadEndpoint ?? 'uploadGrocery',
          currentStep: 'queued',
          createdById: accountId,
        },
      }),
    ));
    try {
      await this.queue.addBulk(executions.map(execution => ({
        name: 'copy-menu-across-apps',
        data: { executionId: execution.id },
        opts: {
          jobId: execution.id,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      })));
      return { created: executions.length, executions };
    } catch (error) {
      await this.prisma.menuCopyExecution.updateMany({
        where: { id: { in: executions.map(execution => execution.id) } },
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
