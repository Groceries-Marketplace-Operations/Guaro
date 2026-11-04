import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

const APP_ID = '5764607780881696497';
const POLICY_VERSION = 'tiendas-neto-weekly-menu-cache-upload-v5';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Injectable()
export class NetoAutomationService {
  private readonly root = path.resolve(process.env.DIDI_NETO_DATA_ROOT || path.join(process.cwd(), 'uploads', 'tiendas-neto'));
  private readonly dataRoot = path.join(this.root, 'weekly-menu-v5');

  private async readJson(file: string): Promise<JsonRecord | null> {
    try { return record(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async checkpoint() {
    const daemon = await this.readJson(path.join(this.dataRoot, 'daemon-state.json'));
    const generationId = stringValue(daemon?.activeGenerationId);
    const safeId = generationId && /^[A-Za-z0-9._-]+$/.test(generationId) && !generationId.includes('..') ? generationId : null;
    const generationDir = safeId ? path.join(this.dataRoot, 'generations', safeId) : null;
    const generation = safeId
      ? await this.readJson(path.join(generationDir!, 'generation.json'))
      : null;
    const [inventoryExists, generationInventoryExists, uploads] = await Promise.all([
      fs.access(path.join(this.dataRoot, 'shop-list.json.gz')).then(() => true).catch(() => false),
      generationDir ? fs.access(path.join(generationDir, 'shop-list.json.gz')).then(() => true).catch(() => false) : false,
      generationDir ? fs.readdir(path.join(generationDir, 'uploads')).catch(() => []) : [],
    ]);
    const cachedStores = numberValue(generation?.cachedStores);
    const currentCycleId = stringValue(daemon?.currentCycleId);
    const safeCycleId = currentCycleId && /^[A-Za-z0-9._-]+$/.test(currentCycleId) && !currentCycleId.includes('..')
      ? currentCycleId : null;
    const currentCycle = safeCycleId
      ? await this.readJson(path.join(this.dataRoot, 'cycles', safeCycleId, 'cycle.json'))
      : null;
    const ready = daemon?.policyVersion === POLICY_VERSION
      && daemon?.appId === APP_ID
      && generation?.status === 'active'
      && inventoryExists && generationInventoryExists
      && cachedStores !== null && cachedStores > 0
      && uploads.filter(file => file.endsWith('.json.gz')).length >= cachedStores
      && (!currentCycleId || (currentCycle?.generationId === safeId && currentCycle?.status === 'running'));
    return { daemon, generation, generationId: safeId, ready };
  }

  async getStatus() {
    const [control, supervisor, runner, checkpoint] = await Promise.all([
      this.readJson(path.join(this.root, 'supervisor-control.json')),
      this.readJson(path.join(this.root, 'supervisor-status.json')),
      this.readJson(path.join(this.dataRoot, 'status.json')),
      this.checkpoint(),
    ]);
    const supervisorUpdatedAt = stringValue(supervisor?.updatedAt);
    const workerOnline = Boolean(supervisorUpdatedAt && Date.now() - Date.parse(supervisorUpdatedAt) < 30_000);
    const progress = record(runner?.progress);
    const daemon = checkpoint.daemon;
    const lastCycleId = stringValue(daemon?.lastCycleId);
    const safeCycleId = lastCycleId && /^[A-Za-z0-9._-]+$/.test(lastCycleId) && !lastCycleId.includes('..') ? lastCycleId : null;
    const cycle = safeCycleId
      ? await this.readJson(path.join(this.dataRoot, 'cycles', safeCycleId, 'cycle.json'))
      : null;
    return {
      enabled: control?.enabled === true,
      workerOnline,
      running: workerOnline && supervisor?.running === true,
      stopping: workerOnline && supervisor?.stopping === true,
      ready: checkpoint.ready,
      phase: stringValue(runner?.phase),
      progress: {
        total: numberValue(progress.total),
        completed: numberValue(progress.completed),
        cached: numberValue(progress.cached),
        skipped: numberValue(progress.skipped),
        inFlight: numberValue(progress.inFlight),
        taskIds: numberValue(progress.taskIds),
        byStatus: Object.fromEntries(Object.entries(record(progress.byStatus))
          .filter(([key, value]) => /^[a-z_]+$/.test(key) && typeof value === 'number')),
      },
      generationId: checkpoint.generationId,
      activeStores: numberValue(checkpoint.generation?.cachedStores),
      currentCycleId: stringValue(daemon?.currentCycleId),
      lastCycle: cycle ? {
        id: safeCycleId,
        status: stringValue(cycle.status),
        stores: numberValue(cycle.stores),
        taskIds: numberValue(cycle.taskIds),
        startedAt: stringValue(cycle.startedAt),
        completedAt: stringValue(cycle.completedAt),
        byStatus: Object.fromEntries(Object.entries(record(cycle.byStatus))
          .filter(([key, value]) => /^[a-z_]+$/.test(key) && typeof value === 'number')),
      } : null,
      nextUploadAt: stringValue(daemon?.nextUploadAt),
      updatedAt: stringValue(runner?.updatedAt),
      workerUpdatedAt: supervisorUpdatedAt,
      lastExit: supervisor?.lastExit ? {
        at: stringValue(record(supervisor.lastExit).at),
        code: numberValue(record(supervisor.lastExit).code),
        signal: stringValue(record(supervisor.lastExit).signal),
        error: stringValue(record(supervisor.lastExit).error),
      } : null,
    };
  }

  async setEnabled(enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean');
    if (enabled && !(await this.checkpoint()).ready) {
      throw new ConflictException('El checkpoint de Tiendas Neto no está listo. Migra la lista, generación y ciclos antes de habilitarlo.');
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, 'supervisor-control.json');
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, enabled, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
    return this.getStatus();
  }
}
