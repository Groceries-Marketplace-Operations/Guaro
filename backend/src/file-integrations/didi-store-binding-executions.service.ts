import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  AccountRole,
  AutoOpenStatus,
  DidiBindingEnvironment,
  DidiStoreBindingAction,
  DidiStoreBindingItemStatus,
  Prisma,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DidiStoreBindingCoordinator } from './didi-store-binding-coordinator.service';
import { DidiStoreBindingsService } from './didi-store-bindings.service';
import {
  CreateDidiStoreBindingExecutionDto,
  GetDidiStoreBindingExecutionDto,
  ListDidiStoreBindingExecutionsDto,
} from './dto/didi-store-binding.dto';
import { redactSensitiveText } from './didi-store-bindings.util';

const ACTIVE_STATUSES: AutoOpenStatus[] = [AutoOpenStatus.pending, AutoOpenStatus.running];

const executionInclude = {
  application: {
    select: {
      id: true,
      appId: true,
      appName: true,
      country: true,
      didiBindingEnvironment: true,
    },
  },
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.DidiStoreBindingExecutionInclude;

type ExecutionWithPublicRelations = Prisma.DidiStoreBindingExecutionGetPayload<{
  include: typeof executionInclude;
}>;

@Injectable()
export class DidiStoreBindingExecutionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bindings: DidiStoreBindingsService,
    private readonly coordinator: DidiStoreBindingCoordinator,
    @InjectQueue('didi-store-bindings') private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    // BullMQ owns exclusive delivery. Ensure an active DB execution still has
    // a durable job after a Redis eviction/deployment without touching its
    // per-item ambiguity state here (the owning worker performs recovery).
    const active = await this.prisma.didiStoreBindingExecution.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true },
      take: 1000,
    });
    for (const execution of active) {
      const recoveryJobId = `${execution.id}-recovery`;
      const existing = await this.queue.getJob(execution.id) ?? await this.queue.getJob(recoveryJobId);
      if (!existing) {
        await this.enqueue(execution.id, execution.id);
        continue;
      }
      const state = await existing.getState();
      if (['failed', 'completed', 'unknown'].includes(state)) {
        await existing.remove().catch(() => undefined);
        await this.enqueue(execution.id, recoveryJobId);
      }
    }
  }

  async create(
    dto: CreateDidiStoreBindingExecutionDto,
    actorId: string,
    actorRoles: AccountRole[],
  ) {
    const requestFingerprint = this.requestFingerprint(dto);
    const repeated = await this.findIdempotent(dto.idempotencyKey, requestFingerprint, actorId);
    if (repeated) return { execution: this.publicExecution(repeated) };

    const created = await this.coordinator.withLock(dto.applicationId, async () => {
      const afterLock = await this.findIdempotent(dto.idempotencyKey, requestFingerprint, actorId);
      if (afterLock) return afterLock;

      const prepared = await this.bindings.prepareMassExecution(dto, actorRoles);
      const active = await this.prisma.didiStoreBindingExecution.findFirst({
        where: { applicationId: dto.applicationId, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) throw new ConflictException('This application already has an active DiDi Bind/Unbind execution');

      const totalBatches = dto.action === DidiStoreBindingAction.bind
        ? Math.ceil(dto.shops.length / 50)
        : new Set(dto.shops.map(shop => shop.remotePageNo)).size;
      try {
        return await this.prisma.$transaction(async tx => {
          const execution = await tx.didiStoreBindingExecution.create({
            data: {
              idempotencyKey: dto.idempotencyKey,
              requestFingerprint,
              applicationSnapshotFingerprint: prepared.applicationSnapshotFingerprint,
              applicationAppIdSnapshot: prepared.application.appId,
              applicationId: dto.applicationId,
              action: dto.action,
              environment: prepared.environment === 'production'
                ? DidiBindingEnvironment.PRODUCTION
                : DidiBindingEnvironment.TEST,
              totalShops: dto.shops.length,
              totalBatches,
              reason: dto.reason?.trim() || null,
              batchFingerprint: prepared.batchFingerprint,
              createdById: actorId,
            },
          });
          await tx.didiStoreBindingExecutionItem.createMany({
            data: dto.shops.map((shop, index) => ({
              executionId: execution.id,
              ordinal: index + 1,
              shopId: shop.shopId,
              appShopId: shop.appShopId,
              remotePageNo: shop.remotePageNo ?? null,
            })),
          });
          await tx.accessControlAudit.create({
            data: {
              actorId,
              scopeType: 'didi_store_binding_mass',
              scopeKey: execution.id,
              before: {
                executionId: execution.id,
                action: dto.action,
                applicationId: dto.applicationId,
                appId: prepared.application.appId,
                environment: prepared.environment,
                totalShops: dto.shops.length,
                batchFingerprint: prepared.batchFingerprint,
                reason: dto.reason?.trim() || undefined,
                productionAcknowledged: prepared.environment === 'production' ? true : undefined,
              } as Prisma.InputJsonValue,
              after: { status: AutoOpenStatus.pending },
            },
          });
          return tx.didiStoreBindingExecution.findUniqueOrThrow({
            where: { id: execution.id },
            include: executionInclude,
          });
        }, { maxWait: 10_000, timeout: 30_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const idempotent = await this.findIdempotent(dto.idempotencyKey, requestFingerprint, actorId);
          if (idempotent) return idempotent;
          throw new ConflictException('This application already has an active DiDi Bind/Unbind execution');
        }
        throw error;
      }
    });

    if (created.status === AutoOpenStatus.pending) {
      try {
        await this.enqueue(created.id);
      } catch (error) {
        const message = redactSensitiveText((error as Error).message);
        await this.prisma.$transaction([
          this.prisma.didiStoreBindingExecutionItem.updateMany({
            where: { executionId: created.id, status: DidiStoreBindingItemStatus.pending },
            data: { status: DidiStoreBindingItemStatus.failed, message, finishedAt: new Date() },
          }),
          this.prisma.didiStoreBindingExecution.update({
            where: { id: created.id },
            data: {
              status: AutoOpenStatus.failed,
              processedShops: created.totalShops,
              failedShops: created.totalShops,
              errorMessage: message,
              finishedAt: new Date(),
            },
          }),
        ]);
        await this.recalculate(created.id);
        throw error;
      }
    }
    return { execution: this.publicExecution(created) };
  }

  async list(dto: ListDidiStoreBindingExecutionsDto) {
    const where = { applicationId: dto.applicationId };
    const [data, total] = await Promise.all([
      this.prisma.didiStoreBindingExecution.findMany({
        where,
        include: executionInclude,
        orderBy: { createdAt: 'desc' },
        take: dto.take,
      }),
      this.prisma.didiStoreBindingExecution.count({ where }),
    ]);
    return { data: data.map(execution => this.publicExecution(execution)), total };
  }

  async detail(id: string, dto: GetDidiStoreBindingExecutionDto) {
    const execution = await this.execution(id);
    const where: Prisma.DidiStoreBindingExecutionItemWhereInput = {
      executionId: id,
      ...(dto.itemStatus ? { status: dto.itemStatus } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.didiStoreBindingExecutionItem.findMany({
        where,
        orderBy: { ordinal: 'asc' },
        skip: (dto.itemPageNo - 1) * dto.itemPageSize,
        take: dto.itemPageSize,
      }),
      this.prisma.didiStoreBindingExecutionItem.count({ where }),
    ]);
    return {
      execution: this.publicExecution(execution),
      items: {
        data: data.map(item => ({
          id: item.id,
          ordinal: item.ordinal,
          shopId: item.shopId,
          appShopId: item.appShopId,
          ...(item.remotePageNo ? { remotePageNo: item.remotePageNo } : {}),
          status: item.status,
          ...(item.message ? { message: item.message } : {}),
          ...(item.startedAt ? { startedAt: item.startedAt } : {}),
          ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
        })),
        total,
        pageNo: dto.itemPageNo,
        pageSize: dto.itemPageSize,
        totalPages: Math.max(1, Math.ceil(total / dto.itemPageSize)),
      },
    };
  }

  async cancel(id: string, actorId: string) {
    const current = await this.execution(id);
    // A client may retry after the first cancellation response timed out. Once
    // cancellation is durable, return the same successful public state instead
    // of turning that safe retry into a 400.
    if (current.status === AutoOpenStatus.cancelled && current.cancelRequested) {
      return { cancelRequested: true, execution: this.publicExecution(current) };
    }
    if (!ACTIVE_STATUSES.includes(current.status)) {
      throw new BadRequestException('This DiDi Bind/Unbind execution is not active');
    }
    if (current.status === AutoOpenStatus.pending) {
      const now = new Date();
      const cancelledPending = await this.prisma.$transaction(async tx => {
        const claimed = await tx.didiStoreBindingExecution.updateMany({
          where: { id, status: AutoOpenStatus.pending },
          data: {
            status: AutoOpenStatus.cancelled,
            cancelRequested: true,
            finishedAt: now,
            currentShopId: null,
            currentBatch: null,
          },
        });
        if (!claimed.count) return false;
        await tx.didiStoreBindingExecutionItem.updateMany({
          where: { executionId: id, status: DidiStoreBindingItemStatus.pending },
          data: { status: DidiStoreBindingItemStatus.cancelled, message: 'Cancelled before submission', finishedAt: now },
        });
        return true;
      });
      if (cancelledPending) {
        await this.recalculate(id);
        const job = await this.queue.getJob(id);
        if (job) {
          const state = await job.getState();
          if (state === 'waiting' || state === 'delayed' || state === 'prioritized') await job.remove();
        }
      } else {
        const requested = await this.prisma.didiStoreBindingExecution.updateMany({
          where: { id, status: AutoOpenStatus.running },
          data: { cancelRequested: true },
        });
        if (!requested.count) throw new BadRequestException('This DiDi Bind/Unbind execution is not active');
      }
    } else {
      // Running cancellation is cooperative. The processor observes this only
      // between safe item/batch boundaries and never interrupts an active POST.
      const requested = await this.prisma.didiStoreBindingExecution.updateMany({
        where: { id, status: AutoOpenStatus.running },
        data: { cancelRequested: true },
      });
      if (!requested.count) throw new BadRequestException('This DiDi Bind/Unbind execution is not active');
    }
    // Cancellation is already durable at this point. Audit enrichment is
    // best-effort so an audit-store outage cannot make the API report failure
    // for an operation that was successfully cancelled.
    await this.mergeAudit(id, {
      cancelRequestedBy: actorId,
      cancelRequestedAt: new Date().toISOString(),
    }).catch(() => undefined);
    const updated = await this.execution(id);
    return { cancelRequested: true, execution: this.publicExecution(updated) };
  }

  async recalculate(id: string) {
    const [execution, grouped] = await Promise.all([
      this.prisma.didiStoreBindingExecution.findUniqueOrThrow({ where: { id } }),
      this.prisma.didiStoreBindingExecutionItem.groupBy({
        by: ['status'],
        where: { executionId: id },
        _count: { _all: true },
      }),
    ]);
    const count = (status: DidiStoreBindingItemStatus) => grouped.find(row => row.status === status)?._count._all ?? 0;
    const successfulShops = count(DidiStoreBindingItemStatus.success);
    const failedShops = count(DidiStoreBindingItemStatus.failed);
    const unconfirmedShops = count(DidiStoreBindingItemStatus.unconfirmed);
    const cancelledShops = count(DidiStoreBindingItemStatus.cancelled);
    const processedShops = successfulShops + failedShops + unconfirmedShops + cancelledShops;
    const complete = processedShops === execution.totalShops;
    let status = execution.status;
    if (complete) {
      status = execution.cancelRequested || cancelledShops > 0
        ? AutoOpenStatus.cancelled
        : successfulShops === execution.totalShops
          ? AutoOpenStatus.done
          : successfulShops > 0
            ? AutoOpenStatus.partial_success
            : AutoOpenStatus.failed;
    }
    const updated = await this.prisma.didiStoreBindingExecution.update({
      where: { id },
      data: {
        status,
        processedShops,
        successfulShops,
        failedShops,
        unconfirmedShops,
        ...(complete ? { finishedAt: new Date(), currentShopId: null, currentBatch: null } : {}),
      },
    });
    if (complete) {
      await this.mergeAudit(id, {
        status,
        totalShops: execution.totalShops,
        processedShops,
        successfulShops,
        failedShops,
        unconfirmedShops,
        cancelledShops,
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return updated;
  }

  async cancelRemaining(id: string, message = 'Cancelled before submission') {
    const now = new Date();
    await this.prisma.didiStoreBindingExecutionItem.updateMany({
      where: {
        executionId: id,
        status: { in: [DidiStoreBindingItemStatus.pending, DidiStoreBindingItemStatus.processing] },
      },
      data: { status: DidiStoreBindingItemStatus.cancelled, message, finishedAt: now },
    });
    await this.prisma.didiStoreBindingExecution.update({
      where: { id },
      data: { cancelRequested: true },
    });
    return this.recalculate(id);
  }

  private requestFingerprint(dto: CreateDidiStoreBindingExecutionDto) {
    return createHash('sha256').update(JSON.stringify({
      applicationId: dto.applicationId,
      action: dto.action,
      shops: dto.shops.map(shop => ({
        shopId: shop.shopId,
        appShopId: shop.appShopId,
        remotePageNo: shop.remotePageNo ?? null,
      })),
      confirmation: dto.confirmation,
      reason: dto.reason?.trim() || null,
      productionAcknowledged: dto.productionAcknowledged === true,
    })).digest('hex');
  }

  private async findIdempotent(key: string, fingerprint: string, actorId: string) {
    const existing = await this.prisma.didiStoreBindingExecution.findUnique({
      where: { idempotencyKey: key },
      include: executionInclude,
    });
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint || existing.createdById !== actorId) {
      throw new ConflictException('idempotencyKey was already used for a different request');
    }
    return existing;
  }

  private enqueue(executionId: string, jobId = executionId) {
    return this.queue.add('execute', { executionId }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    });
  }

  private async execution(id: string) {
    const execution = await this.prisma.didiStoreBindingExecution.findUnique({
      where: { id },
      include: executionInclude,
    });
    if (!execution) throw new NotFoundException('DiDi Bind/Unbind execution not found');
    return execution;
  }

  private async mergeAudit(id: string, patch: Record<string, unknown>) {
    const audit = await this.prisma.accessControlAudit.findFirst({
      where: { scopeType: 'didi_store_binding_mass', scopeKey: id },
      select: { id: true, after: true },
    });
    if (!audit) return;
    const previous = audit.after && typeof audit.after === 'object' && !Array.isArray(audit.after)
      ? audit.after as Record<string, unknown>
      : {};
    await this.prisma.accessControlAudit.update({
      where: { id: audit.id },
      data: { after: { ...previous, ...patch } as Prisma.InputJsonValue },
    });
  }

  private publicExecution(execution: ExecutionWithPublicRelations) {
    return {
      id: execution.id,
      action: execution.action,
      status: execution.status,
      application: {
        id: execution.application.id,
        appId: execution.applicationAppIdSnapshot,
        appName: execution.application.appName,
        country: execution.application.country,
        environment: execution.environment === DidiBindingEnvironment.PRODUCTION ? 'production' : 'test',
      },
      totalShops: execution.totalShops,
      processedShops: execution.processedShops,
      successfulShops: execution.successfulShops,
      failedShops: execution.failedShops,
      unconfirmedShops: execution.unconfirmedShops,
      pendingShops: Math.max(0, execution.totalShops - execution.processedShops),
      ...(execution.currentShopId ? { currentShopId: execution.currentShopId } : {}),
      ...(execution.currentBatch ? { currentBatch: execution.currentBatch } : {}),
      totalBatches: execution.totalBatches,
      cancelRequested: execution.cancelRequested,
      ...(execution.reason ? { reason: execution.reason } : {}),
      createdAt: execution.createdAt,
      ...(execution.startedAt ? { startedAt: execution.startedAt } : {}),
      ...(execution.finishedAt ? { finishedAt: execution.finishedAt } : {}),
      ...(execution.createdBy ? { createdBy: execution.createdBy } : {}),
    };
  }
}

export { ACTIVE_STATUSES };
