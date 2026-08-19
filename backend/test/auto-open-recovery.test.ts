import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AutoOpenStatus } from '@prisma/client';
import { AutoOpenRecoveryService } from '../src/integrations/auto-open-recovery.service';

test('startup recovery closes a legacy running execution without brand checkpoints', async () => {
  const execution = {
    id: 'legacy-running', status: AutoOpenStatus.running, brandRuns: [],
    createdAt: new Date(), startedAt: new Date(), heartbeatAt: new Date(),
  };
  const prisma = {
    autoOpenExecution: {
      findMany: async () => [execution],
      updateMany: async ({ data }: any) => { Object.assign(execution, data); return { count: 1 }; },
    },
  };
  const queue = { getJob: async () => null };
  const processor = { reconcileExecution: async () => undefined };

  const recovery = new AutoOpenRecoveryService(prisma as never, processor as never, queue as never);
  await recovery.onModuleInit();

  assert.equal(execution.status, AutoOpenStatus.failed);
  assert.match((execution as any).errorMessage, /service restart/);
});

test('startup recovery requeues unfinished brand checkpoints after a restart', async () => {
  const run: { id: string; status: AutoOpenStatus; updatedAt: Date; createdAt: Date; errorMessage?: string } = {
    id: 'run-1', status: AutoOpenStatus.running, updatedAt: new Date(), createdAt: new Date(),
  };
  const execution = {
    id: 'segmented-running', status: AutoOpenStatus.running, brandRuns: [run],
    createdAt: new Date(), startedAt: new Date(), heartbeatAt: new Date(),
  };
  const jobs: Array<{ name: string; data: Record<string, string>; options: { jobId: string } }> = [];
  let reconciled = '';
  const prisma = {
    autoOpenExecution: { findMany: async () => [execution] },
    autoOpenBrandExecution: {
      updateMany: async ({ data }: any) => { Object.assign(run, data); return { count: 1 }; },
      findMany: async () => run.status === AutoOpenStatus.pending ? [{ id: run.id }] : [],
    },
  };
  const queue = {
    getJob: async () => null,
    add: async (name: string, data: Record<string, string>, options: { jobId: string }) => {
      jobs.push({ name, data, options });
    },
  };
  const processor = { reconcileExecution: async (id: string) => { reconciled = id; } };

  const recovery = new AutoOpenRecoveryService(prisma as never, processor as never, queue as never);
  await recovery.onModuleInit();

  assert.equal(run.status, AutoOpenStatus.pending);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'run-brand');
  assert.equal(jobs[0].options.jobId, 'auto-open-brand-run-1');
  assert.equal(reconciled, execution.id);
});
