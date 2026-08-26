import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMassiveRtboExecutionDto } from './dto/create-massive-rtbo-execution.dto';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

@Injectable()
export class MassiveRtboService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('massive-rtbo') private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    await this.prisma.massiveRtboExecution.updateMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: new Date(),
        currentShopId: null,
        currentStep: null,
        errorMessage: 'Interrupted by service restart',
      },
    });
  }

  list() {
    return this.prisma.massiveRtboExecution.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        application: { select: { id: true, appId: true, appName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async create(dto: CreateMassiveRtboExecutionDto, accountId: string) {
    const application = await this.prisma.application.findFirst({
      where: { id: dto.applicationId, deletedAt: null },
      select: { id: true, appName: true },
    });
    if (!application) throw new BadRequestException('Application not found');

    const active = await this.prisma.massiveRtboExecution.findFirst({
      where: { applicationId: dto.applicationId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    });
    if (active) throw new BadRequestException('This application already has an active Massive RTBO execution');

    const shopIds = [...new Set(dto.shopIds ?? [])];
    const execution = await this.prisma.massiveRtboExecution.create({
      data: {
        applicationId: dto.applicationId,
        shopIds,
        promiseProduceTime: dto.promiseProduceTime,
        totalShops: shopIds.length,
        currentStep: 'queued',
        createdById: accountId,
      },
    });
    try {
      await this.queue.add('update-promise-produce-time', { executionId: execution.id }, {
        jobId: execution.id,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
      return execution;
    } catch (error) {
      await this.prisma.massiveRtboExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          currentStep: null,
          errorMessage: (error as Error).message,
        },
      });
      throw error;
    }
  }

  async stop(id: string) {
    const result = await this.prisma.massiveRtboExecution.updateMany({
      where: { id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: new Date(),
        currentShopId: null,
        currentStep: null,
        errorMessage: 'Stopped manually',
      },
    });
    if (!result.count) throw new BadRequestException('This Massive RTBO execution is not active');
    return { stopped: true };
  }
}
