import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { resolveSftpApiApplications } from '../src/sftp-api/sftp-api.credentials';
import { SftpApiService, RULE_SELECT } from '../src/sftp-api/sftp-api.service';
import { SftpApiDto } from '../src/sftp-api/sftp-api.dto';

const dto = {
  brandId: '10000000-0000-4000-8000-000000000001',
  applicationId: '10000000-0000-4000-8000-000000000002',
  sftpApplicationId: '10000000-0000-4000-8000-000000000003',
  maxFileAgeMinutes: 30, fileRegex: '\\.csv$', delimiter: '|', hasHeader: false,
  shopSource: 'filename' as const, shopRegex: '(\\d+)\\.csv$',
  mapping: { app_item_id: 'A', stock: 'B', upc: 'A', item_name: 'C', price: 'D' },
  schedules: [{ time: '08:00', mode: 'full' as const }], active: false,
};

function harness() {
  const application = { country: 'MX', appSecret: 'private-api-secret' };
  const sftpApplication = { brandId: dto.brandId as string | null, password: 'private-sftp-secret' };
  const saved: any[] = [];
  const prisma: any = {
    brand: { findFirst: async () => ({ country: 'MX' }) },
    application: { findFirst: async ({ where }: any) => { assert.equal(where.deletedAt, null); return application; } },
    sftpApplication: { findFirst: async ({ where }: any) => { assert.equal(where.active, true); assert.equal(where.deletedAt, null); return sftpApplication; } },
    sftpApiRule: {
      create: async (args: any) => { saved.push(args); return { id: 'rule', ...args.data }; },
      findUnique: async () => ({ id: 'rule', ...dto }),
    },
  };
  const service = new SftpApiService(prisma, { getJob: async () => null, add: async () => {} } as any);
  return { service, prisma, saved, application, sftpApplication };
}

test('save stores required catalog relations and never duplicates credentials', async () => {
  const h = harness();
  await h.service.save(dto, 'actor');
  assert.equal(h.saved[0].data.applicationId, dto.applicationId);
  assert.equal(h.saved[0].data.sftpApplicationId, dto.sftpApplicationId);
  assert.equal(h.saved[0].data.nextRunAt, null);
  for (const key of ['password', 'appSecret', 'host', 'username', 'appId', 'folder']) assert.ok(!(key in h.saved[0].data));
  const select = JSON.stringify(RULE_SELECT);
  assert.ok(!select.includes('password'));
  assert.ok(!select.includes('appSecret'));
});

test('save rejects API applications from another country and SFTP applications from another brand', async () => {
  const h = harness();
  h.application.country = 'CO';
  await assert.rejects(h.service.save(dto, 'actor'), /país/);
  h.application.country = 'MX';
  h.sftpApplication.brandId = 'other-brand';
  await assert.rejects(h.service.save(dto, 'actor'), /otra marca/);
  assert.equal(h.saved.length, 0);
  h.sftpApplication.brandId = null;
  await h.service.save(dto, 'actor');
  assert.equal(h.saved.length, 1);
});

test('missing or deleted catalog entries fail validation', async () => {
  for (const model of ['brand', 'application', 'sftpApplication']) {
    const h = harness();
    h.prisma[model].findFirst = async () => null;
    await assert.rejects(resolveSftpApiApplications(h.prisma, dto));
  }
});

test('DTO accepts relation IDs and rejects legacy credential fields', async () => {
  assert.equal((await validate(plainToInstance(SftpApiDto, dto))).length, 0);
  const errors = await validate(plainToInstance(SftpApiDto, { ...dto, password: 'secret', appSecret: 'secret' }), { whitelist: true, forbidNonWhitelisted: true });
  assert.deepEqual(errors.map(e => e.property).sort(), ['appSecret', 'password']);
});

test('run snapshots contain relation IDs only and unavailable applications are rejected before enqueue', async () => {
  const h = harness();
  const snapshots: any[] = [];
  h.prisma.$queryRaw = async () => [];
  h.prisma.sftpApiRun = { count: async () => 0, create: async ({ data }: any) => { snapshots.push(data.snapshot); return { id: 'run' }; } };
  h.prisma.$transaction = async (fn: any) => fn(h.prisma);
  await h.service.run('rule', 'delta', 'actor');
  assert.equal(snapshots[0].applicationId, dto.applicationId);
  assert.equal(snapshots[0].sftpApplicationId, dto.sftpApplicationId);
  assert.ok(!JSON.stringify(snapshots).includes('secret'));
  h.prisma.application.findFirst = async () => null;
  await assert.rejects(h.service.run('rule', 'delta', 'actor'), /no está disponible/);
  assert.equal(snapshots.length, 1);
});

test('maximum file age must be a positive integer in minutes', async () => {
  for (const value of [0, -1, 1.5, 525601, '30', undefined]) {
    const errors = await validate(plainToInstance(SftpApiDto, { ...dto, maxFileAgeMinutes: value }));
    assert.ok(errors.some(e => e.property === 'maxFileAgeMinutes'));
  }
});

test('file reset is scoped to a rule and preserves upload audits', async () => {
  const h = harness();
  const deleted: any[] = [];
  h.prisma.$queryRaw = async () => [];
  h.prisma.sftpApiRun = { count: async () => 0 };
  h.prisma.sftpApiProcessedFile = { deleteMany: async ({ where }: any) => { deleted.push(where); return { count: 1 }; } };
  h.prisma.$transaction = async (fn: any) => fn(h.prisma);
  assert.deepEqual(await h.service.forgetProcessedFiles('rule', 'file'), { deleted: 1 });
  assert.deepEqual(deleted[0], { ruleId: 'rule', id: 'file' });
  await h.service.forgetProcessedFiles('rule');
  assert.deepEqual(deleted[1], { ruleId: 'rule' });
  h.prisma.sftpApiRun.count = async () => 1;
  await assert.rejects(h.service.forgetProcessedFiles('rule', 'file'), /termine/);
  assert.equal(deleted.length, 2);
  h.prisma.sftpApiRun.count = async () => 0;
  h.prisma.sftpApiProcessedFile.deleteMany = async () => ({ count: 0 });
  await assert.rejects(h.service.forgetProcessedFiles('rule', 'other-brand-file'), /no encontrado/);
});

test('file listing and reset stay scoped to the selected execution', async () => {
  const h = harness();
  let exists = true;
  h.prisma.sftpApiRun = {
    count: async () => 0,
    findFirst: async ({ where }: any) => { assert.deepEqual(where, { id: 'run', ruleId: 'rule' }); return exists ? { id: 'run' } : null; },
  };
  const expected = { ruleId: 'rule', runId: 'run' };
  const deleted: any[] = [];
  h.prisma.sftpApiProcessedFile = {
    findMany: async ({ where, skip, take }: any) => { assert.deepEqual(where, expected); assert.equal(skip, 20); assert.equal(take, 20); return [{ runId: 'run', status: 'error' }]; },
    count: async ({ where }: any) => { assert.deepEqual(where, expected); return 21; },
    deleteMany: async ({ where }: any) => { deleted.push(where); return { count: 1 }; },
  };
  h.prisma.$queryRaw = async () => [];
  h.prisma.$transaction = async (fn: any) => fn(h.prisma);
  assert.deepEqual(await h.service.processedFiles('rule', 2, 'run'), { data: [{ runId: 'run', status: 'error' }], total: 21, page: 2 });
  await h.service.forgetProcessedFiles('rule', undefined, 'run');
  await h.service.forgetProcessedFiles('rule', 'file', 'run');
  assert.deepEqual(deleted, [expected, { ...expected, id: 'file' }]);
  exists = false;
  await assert.rejects(h.service.processedFiles('rule', 2, 'run'), { status: 404 });
  await assert.rejects(h.service.forgetProcessedFiles('rule', undefined, 'run'), { status: 404 });
  assert.equal(deleted.length, 2);
});

test('picker filters catalogs by country and brand without selecting secrets', async () => {
  const h = harness();
  h.prisma.application.findMany = async ({ where, select }: any) => {
    assert.deepEqual(where, { deletedAt: null, country: 'MX' });
    assert.ok(!select.appSecret);
    return [];
  };
  h.prisma.sftpApplication.findMany = async ({ where, select }: any) => {
    assert.equal(where.active, true);
    assert.equal(where.deletedAt, null);
    assert.deepEqual(where.OR, [{ brandId: dto.brandId }, { brandId: null }]);
    assert.ok(!select.password);
    return [];
  };
  assert.deepEqual(await h.service.applicationOptions(dto.brandId), { applications: [], sftpApplications: [] });
});
