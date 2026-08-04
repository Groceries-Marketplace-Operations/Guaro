import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ExecutionType, StepStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('handlers') private handlersQueue: Queue,
    @InjectQueue('forced-open') private forcedOpenQueue: Queue,
  ) {}

  async getQueueStatus() {
    const [handlersCounts, forcedOpenCounts, handlersFailed, forcedOpenFailed] = await Promise.all([
      this.handlersQueue.getJobCounts(),
      this.forcedOpenQueue.getJobCounts(),
      this.handlersQueue.getFailed(0, 10),
      this.forcedOpenQueue.getFailed(0, 5),
    ]);

    return {
      queues: {
        handlers: {
          counts: handlersCounts,
          recentFailed: handlersFailed.map((j) => ({
            id: j.id,
            name: j.name,
            failedReason: j.failedReason,
            data: j.data,
            timestamp: j.timestamp,
            attemptsMade: j.attemptsMade,
          })),
        },
        forcedOpen: {
          counts: forcedOpenCounts,
          recentFailed: forcedOpenFailed.map((j) => ({
            id: j.id,
            name: j.name,
            failedReason: j.failedReason,
            data: j.data,
            timestamp: j.timestamp,
            attemptsMade: j.attemptsMade,
          })),
        },
      },
    };
  }

  async getHandlerLogs(page: number, limit: number, status?: string) {
    const where = {
      stepDefinition: { executionType: ExecutionType.automatic },
      ...(status ? { status: status as StepStatus } : {}),
    };
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.stepInstance.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          status: true,
          note: true,
          result: true,
          failureReason: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          stepDefinition: {
            select: {
              name: true,
              handler: { select: { id: true, name: true } },
              taskType: { select: { id: true, name: true } },
            },
          },
          task: {
            select: {
              id: true,
              brand: { select: { id: true, brandName: true, country: true } },
            },
          },
        },
      }),
      this.prisma.stepInstance.count({ where }),
    ]);

    return { data, total, page, limit };
  }
}
