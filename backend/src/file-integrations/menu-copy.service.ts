import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMenuHandshakeDto } from './dto/create-menu-handshake.dto';
import { CreateMenuCopyDto } from './dto/create-menu-copy.dto';

interface MenuCopyExecutionInput {
  sourceApplicationId: string;
  sourceShopId: string;
  targetApplicationId: string;
  targetShopId: string;
  mergePolicy: number;
  uploadEndpoint: string;
  createdById: string | null;
}

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

    return this.createExecutions(targetShopIds.map(targetShopId => ({
      sourceApplicationId: dto.sourceApplicationId,
      sourceShopId: dto.sourceShopId,
      targetApplicationId: dto.targetApplicationId,
      targetShopId,
      mergePolicy: dto.mergePolicy,
      uploadEndpoint: dto.uploadEndpoint ?? 'uploadGrocery',
      createdById: accountId,
    })));
  }

  async createHandshake(dto: CreateMenuHandshakeDto, accountId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: dto.brandId, deletedAt: null, application: { deletedAt: null } },
      select: {
        applicationId: true,
        application: { select: { id: true } },
        shops: { where: { deletedAt: null }, select: { shopId: true } },
      },
    });
    if (!brand) throw new BadRequestException('Brand not found');
    if (!brand.applicationId || !brand.application) {
      throw new BadRequestException('The brand does not have an active application linked');
    }

    const availableShopIds = new Set(brand.shops.map(shop => shop.shopId));
    const requestedShopIds = dto.mode === 'all_brand'
      ? [...availableShopIds]
      : [...new Set(dto.shopIds ?? [])];
    if (!requestedShopIds.length) {
      throw new BadRequestException(dto.mode === 'all_brand'
        ? 'The brand does not have active stores'
        : 'At least one shop_id is required for shop_list mode');
    }
    if (requestedShopIds.length > 5000) {
      throw new BadRequestException('A forced handshake can include at most 5,000 stores');
    }
    const unknownShopIds = requestedShopIds.filter(shopId => !availableShopIds.has(shopId));
    if (unknownShopIds.length) {
      throw new BadRequestException(
        `These shop_id values do not belong to the selected brand: ${unknownShopIds.slice(0, 20).join(', ')}`,
      );
    }

    const active = await this.prisma.menuCopyExecution.findMany({
      where: {
        status: { in: ['pending', 'running'] },
        sourceApplicationId: brand.applicationId,
        targetApplicationId: brand.applicationId,
        sourceShopId: { in: requestedShopIds },
        targetShopId: { in: requestedShopIds },
      },
      select: { sourceShopId: true, targetShopId: true },
    });
    const activeHandshakeShopIds = new Set(
      active.filter(item => item.sourceShopId === item.targetShopId).map(item => item.sourceShopId),
    );
    const selectedShopIds = requestedShopIds.filter(shopId => !activeHandshakeShopIds.has(shopId));
    if (!selectedShopIds.length) {
      return { created: 0, skippedActive: requestedShopIds.length, executions: [] };
    }

    const result = await this.createExecutions(selectedShopIds.map(shopId => ({
      sourceApplicationId: brand.applicationId!,
      sourceShopId: shopId,
      targetApplicationId: brand.applicationId!,
      targetShopId: shopId,
      mergePolicy: 1,
      uploadEndpoint: 'uploadGrocery',
      createdById: accountId,
    })));
    return { ...result, skippedActive: activeHandshakeShopIds.size };
  }

  async retry(id: string, accountId: string) {
    const execution = await this.prisma.menuCopyExecution.findUnique({ where: { id } });
    if (!execution) throw new BadRequestException('Menu copy execution not found');
    if (['pending', 'running'].includes(execution.status)) {
      throw new BadRequestException('An active menu copy cannot be retried');
    }
    return this.createExecutions([{
      sourceApplicationId: execution.sourceApplicationId,
      sourceShopId: execution.sourceShopId,
      targetApplicationId: execution.targetApplicationId,
      targetShopId: execution.targetShopId,
      mergePolicy: execution.mergePolicy,
      uploadEndpoint: execution.uploadEndpoint,
      createdById: accountId,
    }]);
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

  private async createExecutions(inputs: MenuCopyExecutionInput[]) {
    const executions = await this.prisma.menuCopyExecution.createManyAndReturn({
      data: inputs.map(input => ({ ...input, currentStep: 'queued' })),
    });
    try {
      for (let offset = 0; offset < executions.length; offset += 500) {
        await this.queue.addBulk(executions.slice(offset, offset + 500).map(execution => ({
          name: 'copy-menu-across-apps',
          data: { executionId: execution.id },
          opts: {
            jobId: execution.id,
            attempts: 1,
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        })));
      }
      return { created: executions.length, executions };
    } catch (error) {
      await this.prisma.menuCopyExecution.updateMany({
        where: { id: { in: executions.map(execution => execution.id) }, status: 'pending' },
        data: { status: 'failed', finishedAt: new Date(), currentStep: null, errorMessage: (error as Error).message },
      });
      throw error;
    }
  }
}
