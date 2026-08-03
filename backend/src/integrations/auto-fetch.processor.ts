import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { KaType, Prisma } from '@prisma/client';
import { CatalogSyncService } from '../catalog/catalog-sync.service';
import { PrismaService } from '../prisma/prisma.service';

interface FetchLog {
  brandId: string;
  brandName: string;
  success: boolean;
  shops: number;
  items: number;
  error?: string;
}

class CountryFetchStoppedError extends Error {}
class BrandFetchStoppedError extends Error {}

@Injectable()
@Processor('auto-fetch', { concurrency: 3 })
export class AutoFetchProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoFetchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogSyncService,
  ) { super(); }

  async process(job: Job<{ executionId: string }>) {
    const executionId = job.data.executionId;
    const claimed = await this.prisma.autoFetchExecution.updateMany({
      where: { id: executionId, status: 'pending', cancelRequested: false },
      data: { status: 'running', startedAt: new Date(), progressPercent: 0, errorMessage: null },
    });
    if (claimed.count === 0) return;
    const execution = await this.prisma.autoFetchExecution.findUnique({
      where: { id: executionId },
      include: { pool: { include: { brandSettings: true } } },
    });
    if (!execution) return;

    const settings = new Map(execution.pool.brandSettings.map(setting => [setting.brandId, setting]));
    const manualCkaIds = execution.pool.brandSettings
      .filter(setting => setting.manuallyIncluded && setting.active)
      .map(setting => setting.brandId);
    const brands = (await this.prisma.brand.findMany({
      where: execution.requestedBrandIds.length > 0
        ? {
            id: { in: execution.requestedBrandIds },
            country: execution.pool.country,
            deletedAt: null,
            applicationId: { not: null },
          }
        : {
            country: execution.pool.country,
            deletedAt: null,
            applicationId: { not: null },
            OR: [
              { kaType: KaType.KA },
              { id: { in: manualCkaIds }, kaType: KaType.CKA },
            ],
          },
      select: {
        id: true,
        brandName: true,
        kaType: true,
        _count: { select: { shops: { where: { deletedAt: null } } } },
      },
      orderBy: [{ applicationId: 'asc' }, { brandName: 'asc' }],
    })).filter(brand => execution.requestedBrandIds.length > 0 || settings.get(brand.id)?.active !== false);

    await this.prisma.autoFetchExecution.update({
      where: { id: executionId },
      data: { totalBrands: brands.length },
    });

    const logs: FetchLog[] = [];
    let successful = 0;
    let complete = 0;
    let cancelled = 0;
    let countryCancelled = false;
    let totalShops = 0;
    let totalItems = 0;
    for (let index = 0; index < brands.length; index++) {
      const brand = brands[index];
      try {
        await this.ensureActive(executionId, brand.id);
      } catch (error) {
        if (error instanceof CountryFetchStoppedError) {
          countryCancelled = true;
          break;
        }
        cancelled++;
        logs.push({ brandId: brand.id, brandName: brand.brandName, success: false, shops: 0, items: 0, error: 'Stopped manually' });
        continue;
      }

      await this.prisma.autoFetchExecution.updateMany({
        where: { id: executionId, status: 'running' },
        data: { currentBrand: brand.brandName, progressPercent: Math.floor((index / Math.max(brands.length, 1)) * 100) },
      });
      const ensureActive = () => this.ensureActive(executionId, brand.id);
      try {
        if (execution.pool.kind === 'stores') {
          const result = await this.catalog.syncBrandStores(brand.id, ensureActive);
          await ensureActive();
          totalShops += result.totalShops;
          logs.push({
            brandId: brand.id,
            brandName: brand.brandName,
            success: true,
            shops: result.totalShops,
            items: 0,
            error: result.detailFailures > 0 ? `${result.detailFailures} shop detail(s) failed` : undefined,
          });
          successful++;
          if (result.detailFailures === 0) complete++;
        } else {
          let storeDetailFailures = 0;
          if (brand._count.shops === 0) {
            const storeResult = await this.catalog.syncBrandStores(brand.id, ensureActive);
            storeDetailFailures = storeResult.detailFailures;
          }
          const result = await this.catalog.syncBrandMenus(brand.id, undefined, ensureActive);
          await ensureActive();
          totalShops += result.totalShops;
          totalItems += result.totalItems;
          const success = result.shopsSucceeded > 0 || result.totalShops === 0;
          logs.push({
            brandId: brand.id,
            brandName: brand.brandName,
            success,
            shops: result.shopsSucceeded,
            items: result.totalItems,
            error: [
              storeDetailFailures > 0 ? `${storeDetailFailures} shop detail(s) failed` : '',
              result.shopsFailed > 0 ? `${result.shopsFailed} menu(s) failed` : '',
            ].filter(Boolean).join('; ') || undefined,
          });
          if (!success) throw new Error(result.failures[0]?.error ?? 'All menu downloads failed');
          successful++;
          if (result.shopsFailed === 0 && storeDetailFailures === 0) complete++;
        }
      } catch (error) {
        if (error instanceof CountryFetchStoppedError) {
          countryCancelled = true;
          break;
        }
        if (error instanceof BrandFetchStoppedError) {
          cancelled++;
          logs.push({ brandId: brand.id, brandName: brand.brandName, success: false, shops: 0, items: 0, error: 'Stopped manually' });
          continue;
        }
        const existing = logs.find(log => log.brandId === brand.id);
        if (existing) existing.error = (error as Error).message;
        else logs.push({ brandId: brand.id, brandName: brand.brandName, success: false, shops: 0, items: 0, error: (error as Error).message });
        this.logger.error(`${execution.pool.kind} fetch failed for ${brand.brandName}: ${(error as Error).message}`);
      }
    }

    const allCancelled = brands.length > 0 && cancelled === brands.length;
    const status = countryCancelled || allCancelled
      ? 'cancelled'
      : complete === brands.length
        ? 'done'
        : successful > 0 ? 'partial_success' : 'failed';
    const firstError = logs.find(log => log.error)?.error;
    await this.prisma.autoFetchExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: {
        status,
        finishedAt: new Date(),
        brandsSucceeded: successful,
        totalShops,
        totalItems,
        progressPercent: 100,
        currentBrand: null,
        errorMessage: status === 'done'
          ? null
          : status === 'cancelled' ? 'Stopped manually' : firstError ?? 'One or more brands failed',
        logs: { brands: logs } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async ensureActive(executionId: string, brandId: string) {
    const execution = await this.prisma.autoFetchExecution.findUnique({
      where: { id: executionId },
      select: { status: true, cancelRequested: true, cancelledBrandIds: true },
    });
    if (execution?.status !== 'running' || execution.cancelRequested) throw new CountryFetchStoppedError();
    if (execution.cancelledBrandIds.includes(brandId)) throw new BrandFetchStoppedError();
  }

  @OnWorkerEvent('failed')
  async failed(job: Job<{ executionId: string }> | undefined, error: Error) {
    if (!job?.data.executionId) return;
    await this.prisma.autoFetchExecution.updateMany({
      where: { id: job.data.executionId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), progressPercent: 100, errorMessage: error.message },
    });
  }
}
