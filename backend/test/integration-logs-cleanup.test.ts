import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { IntegrationLogsCleanupService, INTEGRATION_LOG_RETENTION_MS, INTEGRATION_LOG_CLEANUP_CRON, SFTP_UPLOAD_CLEANUP_BATCH_SIZE } from '../src/scheduler/integration-logs-cleanup.service';
import { CronTime } from 'cron';

const now = Date.parse('2026-10-22T18:00:00Z');
const cutoff = new Date(now - INTEGRATION_LOG_RETENTION_MS);
const old = new Date(cutoff.getTime() - 1);
const recent = new Date(now - 60_000);
type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null || typeof value !== 'object') return row[key] === value;
    if ('lt' in value && !(row[key] != null && row[key] < value.lt)) return false;
    if ('not' in value && row[key] === value.not) return false;
    if ('in' in value && !value.in.includes(row[key])) return false;
    if ('notIn' in value && value.notIn.includes(row[key])) return false;
    return true;
  });
}

function harness() {
  const state = { requests: [] as Row[], runs: [] as Row[], files: [] as Row[], uploads: [] as Row[] };
  const errors: string[] = [];
  const logs: string[] = [];
  const uploadDeleteSizes: number[] = [];
  let acquired = true;
  let requestFailure = false;
  let runFailure = false;
  let batches = 0;
  const model = (key: keyof typeof state) => ({
    findMany: async ({ where, take }: Row) => state[key].filter(row => matches(row, where)).slice(0, take).map(row => ({ id: row.id })),
    updateMany: async ({ where, data }: Row) => {
      const rows = state[key].filter(row => matches(row, where));
      rows.forEach(row => Object.assign(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row) => {
      if ((key === 'requests' && requestFailure) || (key === 'runs' && runFailure)) throw new Error('Injected DB error');
      const rows = state[key].filter(row => matches(row, where));
      if (key === 'uploads') uploadDeleteSizes.push(rows.length);
      if (key === 'runs') for (const row of rows) {
        assert.ok(!state.files.some(file => file.runId === row.id), 'detach markers before removing runs');
        assert.ok(!state.uploads.some(upload => upload.runId === row.id), 'remove uploads before runs');
      }
      state[key] = state[key].filter(row => !rows.includes(row));
      return { count: rows.length };
    },
  });
  const tx = {
    $queryRaw: async () => [{ acquired }],
    didiOrderWebhookRequest: model('requests'),
    // No event model: touching the confirmation ledger is an error in this test.
    sftpApiRun: model('runs'), sftpApiProcessedFile: model('files'), sftpApiUpload: model('uploads'),
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<any>) => {
      batches++;
      const snapshot = structuredClone(state);
      try { return await fn(tx); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
  };
  const service = new IntegrationLogsCleanupService(prisma as any);
  (service as any).logger = { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) };
  return { state, service, prisma, errors, logs, uploadDeleteSizes, denyLock: () => { acquired = false; },
    failRequests: () => { requestFailure = true; }, failRuns: () => { runFailure = true; }, recoverRuns: () => { runFailure = false; }, batches: () => batches };
}

test('72-hour boundary is strict; active work and recently completed SFTP runs survive', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.state.requests.push(
    { id: 'old', createdAt: old, completedAt: old, outcome: 'accepted' },
    { id: 'boundary', createdAt: cutoff, completedAt: cutoff, outcome: 'failed' },
    { id: 'recent', createdAt: recent, completedAt: recent, outcome: 'rejected' },
    { id: 'active', createdAt: old, completedAt: null, outcome: 'processing' },
  );
  h.state.runs.push(
    { id: 'old', createdAt: old, finishedAt: old, status: 'needs_review' },
    { id: 'boundary', createdAt: old, finishedAt: cutoff, status: 'failed' },
    { id: 'recent-finish', createdAt: old, finishedAt: recent, status: 'accepted' },
    { id: 'active', createdAt: old, finishedAt: null, status: 'running' },
    { id: 'pending', createdAt: old, finishedAt: null, status: 'pending' },
  );
  h.state.files.push({ id: 'marker', ruleId: 'rule', runId: 'old', fileName: 'old.csv', fileHash: 'hash', error: 'detail', status: 'needs_review' });
  h.state.uploads.push({ id: 'old-upload', runId: 'old' }, { id: 'active-upload', runId: 'active' });
  try {
    await h.service.cleanup();
    assert.deepEqual(h.state.requests.map(row => row.id), ['boundary', 'recent', 'active']);
    assert.deepEqual(h.state.runs.map(row => row.id), ['boundary', 'recent-finish', 'active', 'pending']);
    assert.deepEqual(h.state.uploads.map(row => row.id), ['active-upload']);
    assert.deepEqual(h.state.files, [{ id: 'marker', ruleId: 'rule', runId: null, fileName: 'old.csv', fileHash: null, error: null, status: 'needs_review' }]);
    await h.service.cleanup();
    assert.equal(h.state.files.length, 1, 'cleanup is idempotent and preserves deduplication');
    assert.equal(h.errors.length, 0);
  } finally { mock.restoreAll(); }
});

test('cleanup drains multiple bounded batches for both histories', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.state.requests.push(...Array.from({ length: 1001 }, (_, i) => ({ id: String(i), createdAt: old, completedAt: old, outcome: 'deduplicated' })));
  h.state.runs.push(...Array.from({ length: 3 }, (_, i) => ({ id: String(i), createdAt: old, finishedAt: old, status: 'accepted' })));
  try {
    await h.service.cleanup();
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.runs.length, 0);
    assert.equal(h.batches(), 6);
  } finally { mock.restoreAll(); }
});

test('another replica holding the advisory lock prevents any deletion', async () => {
  const h = harness();
  h.denyLock();
  h.state.requests.push({ id: 'old', createdAt: old, completedAt: old, outcome: 'accepted' });
  await h.service.cleanup();
  assert.equal(h.state.requests.length, 1);
  assert.ok(h.logs.some(log => log.includes('fin=bloqueo_ocupado')));
});

test('a webhook cleanup error does not stop SFTP cleanup and the next tick can retry', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.failRequests();
  h.state.requests.push({ id: 'old', createdAt: old, completedAt: old, outcome: 'accepted' });
  h.state.runs.push({ id: 'old', createdAt: old, finishedAt: old, status: 'failed' });
  try {
    await h.service.cleanup();
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.runs.length, 0);
    assert.equal(h.errors.length, 1);
    await h.service.cleanup();
    assert.equal(h.errors.length, 2);
  } finally { mock.restoreAll(); }
});

test('SFTP cleanup rolls back marker changes and deleted uploads if deleting runs fails', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.failRuns();
  h.state.runs.push({ id: 'old', createdAt: old, finishedAt: old, status: 'failed' });
  h.state.files.push({ id: 'marker', runId: 'old', fileHash: 'hash', error: 'detail' });
  h.state.uploads.push({ id: 'upload', runId: 'old' });
  const before = structuredClone(h.state);
  try {
    await h.service.cleanup();
    assert.deepEqual(h.state, before);
    assert.equal(h.errors.length, 1);
  } finally { mock.restoreAll(); }
});

test('overlapping ticks in the same process do not start a second cleanup', async () => {
  const h = harness();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transaction = h.prisma.$transaction;
  mock.method(h.prisma, '$transaction', async (fn: any) => { await barrier; return transaction(fn); });
  try {
    const first = h.service.cleanup();
    await h.service.cleanup();
    release();
    await first;
    assert.equal(h.batches(), 2);
  } finally { mock.restoreAll(); }
});

test('night schedule resumes every ten minutes from 03:00 through 05:50 Mexico time', () => {
  const cron = new CronTime(INTEGRATION_LOG_CLEANUP_CRON, 'America/Mexico_City');
  let next = new Date('2026-10-28T08:59:00Z');
  for (let i = 0; i < 18; i++) {
    const date = cron.getNextDateFrom(next, 'America/Mexico_City').toJSDate();
    assert.equal(date.getTime(), Date.parse('2026-10-28T09:00:00Z') + i * 600_000);
    next = date;
  }
  assert.equal(cron.getNextDateFrom(next, 'America/Mexico_City').toJSDate().toISOString(), '2026-10-29T09:00:00.000Z');
});

test('large SFTP histories commit bounded child chunks and resume after reaching the pass limit', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.state.runs.push({ id: 'large', createdAt: old, finishedAt: old, status: 'accepted' });
  h.state.files.push(...Array.from({ length: 205 }, (_, i) => ({ id: `file-${i}`, runId: 'large', fileName: `${i}.csv`, status: 'accepted', fileHash: 'hash', error: 'old audit' })));
  h.state.uploads.push(...Array.from({ length: 2501 }, (_, i) => ({ id: `upload-${i}`, runId: 'large' })));
  try {
    await h.service.cleanup();
    assert.equal(h.state.uploads.length, 1);
    assert.equal(h.state.runs.length, 1);
    assert.equal(h.state.files.length, 205, 'file identities must survive for deduplication');
    assert.ok(h.state.files.every(file => file.runId === null && file.fileHash === null && file.error === null && file.status === 'accepted'));
    assert.ok(h.uploadDeleteSizes.every(count => count <= SFTP_UPLOAD_CLEANUP_BATCH_SIZE));
    assert.ok(h.logs.some(log => log.includes('SFTP to API: 0 registros') && log.includes('2500 envíos') && log.includes('fin=limite_de_lotes')));
    await h.service.cleanup();
    assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.runs.length, 0);
    assert.equal(h.errors.length, 0);
  } finally { mock.restoreAll(); }
});

test('failure in a later SFTP transaction preserves earlier commits and retries only remaining children', async () => {
  mock.method(Date, 'now', () => now);
  const h = harness();
  h.state.runs.push({ id: 'large', createdAt: old, finishedAt: old, status: 'accepted' });
  h.state.files.push({ id: 'marker', runId: 'large', status: 'accepted', fileHash: 'hash' });
  h.state.uploads.push(...Array.from({ length: 26 }, (_, i) => ({ id: String(i), runId: 'large' })));
  h.failRuns();
  try {
    await h.service.cleanup();
    assert.equal(h.state.uploads.length, 1, 'only the final failing chunk is rolled back');
    assert.equal(h.state.files[0].runId, null);
    assert.equal(h.state.runs.length, 1);
    assert.equal(h.errors.length, 1);
    assert.ok(h.logs.some(log => log.includes('Avance confirmado antes del error') && log.includes('25 envíos')));
    h.recoverRuns();
    await h.service.cleanup();
    assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.runs.length, 0);
    assert.equal(h.state.files.length, 1);
  } finally { mock.restoreAll(); }
});

test('pass time budget stops between commits and allows the next history to run', async () => {
  let clock = now;
  mock.method(Date, 'now', () => clock);
  const h = harness();
  h.state.requests.push(...Array.from({ length: 1001 }, (_, i) => ({ id: String(i), createdAt: old, completedAt: old, outcome: 'accepted' })));
  h.state.runs.push({ id: 'old', createdAt: old, finishedAt: old, status: 'accepted' });
  const transaction = h.prisma.$transaction;
  mock.method(h.prisma, '$transaction', async (fn: any) => {
    const result = await transaction(fn);
    clock += 60_000;
    return result;
  });
  try {
    await h.service.cleanup();
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.runs.length, 0);
    assert.ok(h.logs.some(log => log.includes('fin=limite_de_tiempo')));
  } finally { mock.restoreAll(); }
});
