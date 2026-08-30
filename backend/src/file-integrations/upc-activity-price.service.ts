import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertUpcActivityPriceRuleDto } from './dto/upsert-upc-activity-price-rule.dto';
import { nextOfferMenuRun } from './offer-menu-upload.util';

const ACTIVE_STATUSES = ['pending', 'running'] as const;
const LIVE_QUEUE_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

@Injectable()
export class UpcActivityPriceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('upc-activity-price') private readonly queue: Queue,
  ) {}

  list() {
    return this.prisma.upcActivityPriceRule.findMany({
      where: { deletedAt: null },
      include: {
        application: { select: { id: true, appId: true, appName: true, country: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        executions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async execution(id: string) {
    const execution = await this.prisma.upcActivityPriceExecution.findUnique({ where: { id } });
    if (!execution) throw new NotFoundException('UPC activity-price execution not found');
    return execution;
  }

  async create(dto: UpsertUpcActivityPriceRuleDto, accountId: string) {
    const data = await this.normalize(dto);
    const rule = await this.prisma.upcActivityPriceRule.create({
      data: { ...data, createdById: accountId, updatedById: accountId },
    });
    const execution = dto.runNow ? await this.run(rule.id, accountId) : null;
    return { rule, execution };
  }

  async update(id: string, dto: UpsertUpcActivityPriceRuleDto, accountId: string) {
    await this.findRule(id);
    await this.assertNotRunning(id);
    const data = await this.normalize(dto);
    return this.prisma.upcActivityPriceRule.update({
      where: { id },
      data: { ...data, updatedById: accountId },
    });
  }

  async remove(id: string) {
    await this.findRule(id);
    await this.assertNotRunning(id);
    return this.prisma.upcActivityPriceRule.update({
      where: { id },
      data: { active: false, nextRunAt: null, deletedAt: new Date() },
    });
  }

  async run(id: string, accountId?: string, trigger = 'manual') {
    const execution = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'upc-activity-price:' + id}))`;
      const rule = await tx.upcActivityPriceRule.findFirst({ where: { id, deletedAt: null } });
      if (!rule) throw new NotFoundException('UPC activity-price rule not found');
      this.assertLiveAllowed(rule.dryRun);
      this.assertLiveScope(rule.dryRun, rule.shopIds);
      const running = await tx.upcActivityPriceExecution.count({
        where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (running) throw new BadRequestException('This UPC activity-price rule is already running');
      return tx.upcActivityPriceExecution.create({
        data: {
          ruleId: id,
          trigger,
          dryRun: rule.dryRun,
          totalShops: rule.shopIds.length,
          createdById: accountId,
        },
      });
    });
    try {
      await this.enqueue(execution.id, execution.id);
    } catch (error) {
      // Queue delivery is ambiguous when Redis accepts the job but the client
      // loses the response. Keep the execution pending so the scheduler can
      // reconcile the deterministic job ID without creating a new execution.
      await this.prisma.upcActivityPriceExecution.updateMany({
        where: { id: execution.id, status: 'pending' },
        data: { errorMessage: 'Queue delivery could not be confirmed; automatic recovery pending' },
      }).catch(() => undefined);
      throw error;
    }
    return execution;
  }

  async ensureExecutionQueued(id: string) {
    return this.prisma.$transaction(async tx => {
      // Multiple application replicas may run startup/minute recovery. The
      // database lock makes inspection + replacement of the stable recovery
      // job ID a single-writer operation across replicas.
      // pg_advisory_xact_lock returns PostgreSQL void. Prisma cannot
      // deserialize that pseudo-type through $queryRaw, so execute it as a
      // statement just like the creation-path lock above.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'upc-activity-price-recovery:' + id}))`;
      const execution = await tx.upcActivityPriceExecution.findUnique({
        where: { id },
        select: { status: true, result: true, manualReviewRequired: true },
      });
      if (!execution || !ACTIVE_STATUSES.includes(execution.status as (typeof ACTIVE_STATUSES)[number])) {
        return 'inactive' as const;
      }
      if (execution.manualReviewRequired || this.requiresManualReview(execution.result)) {
        return 'manual_review' as const;
      }

      const recoveryJobId = `${id}-recovery`;
      const [primary, recovery] = await Promise.all([
        this.queue.getJob(id),
        this.queue.getJob(recoveryJobId),
      ]);
      for (const job of [primary, recovery]) {
        if (job && LIVE_QUEUE_STATES.has(await job.getState())) return 'live' as const;
      }

      // Keep the original job as immutable history. A terminal recovery job
      // can be replaced only while holding the advisory lock above.
      // Do not hide a removal error: adding with the same ID while the failed
      // job still exists would look successful but would not make it runnable.
      if (recovery) await recovery.remove();
      await this.enqueue(id, recoveryJobId);
      return 'queued' as const;
    }, { maxWait: 5_000, timeout: 20_000 });
  }

  async stop(id: string) {
    await this.findRule(id);
    const executions = await this.prisma.upcActivityPriceExecution.findMany({
      where: { ruleId: id, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, status: true, result: true, manualReviewRequired: true },
    });
    if (!executions.length) throw new BadRequestException('This rule has no active execution');
    const manualReviewIds = executions
      .filter(value => value.status === 'running'
        && (value.manualReviewRequired || this.requiresManualReview(value.result)))
      .map(value => value.id);
    const cooperativeRunningIds = executions
      .filter(value => value.status === 'running' && !manualReviewIds.includes(value.id))
      .map(value => value.id);
    const [cancelledPending, cancelledManualReview, requestedRunning] = await this.prisma.$transaction([
      this.prisma.upcActivityPriceExecution.updateMany({
        where: { ruleId: id, status: 'pending' },
        data: {
          cancelRequested: true,
          status: 'cancelled',
          finishedAt: new Date(),
          currentShopId: null,
          manualReviewRequired: false,
          errorMessage: 'Stopped manually before remote submission',
        },
      }),
      this.prisma.upcActivityPriceExecution.updateMany({
        where: { id: { in: manualReviewIds }, status: 'running' },
        data: {
          cancelRequested: true,
          status: 'cancelled',
          finishedAt: new Date(),
          currentShopId: null,
          manualReviewRequired: false,
          errorMessage: 'Manual review acknowledged; the ambiguous upload was not resubmitted',
        },
      }),
      this.prisma.upcActivityPriceExecution.updateMany({
        where: { id: { in: cooperativeRunningIds }, status: 'running' },
        data: {
          cancelRequested: true,
          errorMessage: 'Stop requested; monitoring accepted remote tasks until terminal status',
        },
      }),
    ]);
    if (!cancelledPending.count && !cancelledManualReview.count && !requestedRunning.count) {
      throw new BadRequestException('This rule has no active execution');
    }

    // Removing a not-yet-started job is only cleanup; the durable DB status is
    // already terminal. Never remove an active job, because it may be between
    // remote submission and persistence and must be allowed to reconcile.
    if (cancelledPending.count || cancelledManualReview.count) {
      for (const execution of executions) {
        const current = await this.prisma.upcActivityPriceExecution.findUnique({
          where: { id: execution.id },
          select: { status: true },
        });
        if (current?.status !== 'cancelled') continue;
        for (const jobId of [execution.id, `${execution.id}-recovery`]) {
          const job = await this.queue.getJob(jobId).catch(() => undefined);
          if (!job) continue;
          const state = await job.getState().catch(() => 'unknown');
          if (['waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
            await job.remove().catch(() => undefined);
          }
        }
      }
    }
    return {
      stopped: true,
      monitoringAcceptedTasks: requestedRunning.count > 0,
      manualReviewClosed: cancelledManualReview.count > 0,
    };
  }

  private async normalize(dto: UpsertUpcActivityPriceRuleDto) {
    const application = await this.prisma.application.findFirst({
      where: { id: dto.applicationId, deletedAt: null },
      select: { id: true },
    });
    if (!application) throw new BadRequestException('Application not found');
    const timezone = dto.timezone?.trim() || 'America/Mexico_City';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException('Invalid IANA timezone');
    }
    const shopIds = [...new Set(dto.shopIds.map(value => value.trim()).filter(Boolean))];
    if (!shopIds.length) throw new BadRequestException('At least one Shop ID is required');
    const scheduleHours = [...new Set(dto.scheduleHours)].sort((a, b) => a - b);
    const dryRun = dto.dryRun ?? true;
    const active = dto.active ?? false;
    this.assertLiveAllowed(dryRun);
    this.assertLiveScope(dryRun, shopIds);
    return {
      name: dto.name.trim(),
      applicationId: dto.applicationId,
      shopIds,
      targetUpc: dto.targetUpc.trim(),
      active,
      dryRun,
      scheduleHours,
      timezone,
      // Task checkpoints are stored as one serialized execution snapshot.
      // Keep one shop in flight so a later write cannot overwrite a taskID.
      storeConcurrency: 1,
      nextRunAt: active ? nextOfferMenuRun(scheduleHours, timezone) : null,
    };
  }

  private assertLiveAllowed(dryRun: boolean) {
    const enabled = this.config.get('UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED', 'false').trim().toLowerCase() === 'true';
    if (!dryRun && !enabled) {
      throw new BadRequestException(
        'Live UPC activity-price writes are disabled on this server. Keep UPC_ACTIVITY_PRICE_REMOTE_WRITE_ENABLED=false '
        + 'until a dry-run is reviewed and the one-store production pilot is explicitly enabled.',
      );
    }
  }

  private assertLiveScope(dryRun: boolean, shopIds: string[]) {
    if (dryRun) return;
    const allowlist = new Set(
      this.config.get<string>('UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST', '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    );
    if (shopIds.length !== 1 || !allowlist.has(shopIds[0]?.trim())) {
      throw new BadRequestException(
        'Live UPC activity-price is restricted to exactly one reviewed app_shop_id from '
        + 'UPC_ACTIVITY_PRICE_LIVE_SHOP_ALLOWLIST; keep the hourly multi-store rule in dry-run mode',
      );
    }
  }

  private enqueue(executionId: string, jobId: string) {
    return this.queue.add('upc-activity-price-run', { executionId }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  private requiresManualReview(result: unknown) {
    return Boolean(
      result
      && typeof result === 'object'
      && !Array.isArray(result)
      && (result as Record<string, unknown>).requiresManualReview === true,
    );
  }

  private async assertNotRunning(ruleId: string) {
    const running = await this.prisma.upcActivityPriceExecution.count({
      where: { ruleId, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (running) throw new BadRequestException('Stop the active execution before changing this rule');
  }

  private async findRule(id: string) {
    const rule = await this.prisma.upcActivityPriceRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw new NotFoundException('UPC activity-price rule not found');
    return rule;
  }
}
