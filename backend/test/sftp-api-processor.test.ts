import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import SftpClient = require('ssh2-sftp-client');
import { SftpApiProcessor } from '../src/sftp-api/sftp-api.processor';
import { decrypt, encrypt } from '../src/common/crypto.util';

const key = '01'.repeat(32);
function harness(mode: 'full' | 'delta', options: { fail?: boolean; reject?: boolean; previous?: boolean; interrupted?: boolean; content?: string; files?: { name: string; content?: string; ageMinutes?: number }[]; rejectShop?: string; authFailShop?: string; uncertainShop?: string } = {}) {
  const content = Buffer.from(options.content ?? '001234|Leche|||18||7||20');
  const rule = { id: 'rule', brandId: 'brand', applicationId: 'api', sftpApplicationId: 'sftp', maxFileAgeMinutes: 30, fileRegex: '\\.csv$', hasHeader: false, delimiter: '|', shopSource: 'filename', shopRegex: '(\\d{4})\\.csv$', mapping: { app_item_id: 'A', upc: 'A', item_name: 'B', activity_price: 'E', stock: 'G', price: 'I' }, active: true };
  const application = { id: 'api', country: 'MX', appId: 'app', appSecret: encrypt('api-secret', key) };
  const sftpApplication = { id: 'sftp', brandId: 'brand', rootPath: '/upload' as string | null, host: 'example.test', port: 22, username: 'test', password: encrypt('sftp-secret', key) };
  const connections: any[] = [];
  const requests: any[] = [];
  const paths: { list: string[]; get: string[]; stat: string[] } = { list: [], get: [], stat: [] };
  const run = { id: 'run', ruleId: 'rule', mode, snapshot: rule, status: options.interrupted ? 'running' : 'pending' };
  const uploads: any[] = [];
  const posts: any[] = [];
  const modified = Date.now() - 120_000;
  const files = (options.files ?? [{ name: '0043.csv' }]).map(file => ({ name: file.name, buffer: file.content === undefined ? content : Buffer.from(file.content), modified: file.ageMinutes === undefined ? modified : Date.now() - file.ageMinutes * 60_000 }));
  const records: any[] = options.previous ? [{ id: 'previous', ruleId: 'rule', fileName: '0043.csv', status: 'processed' }] : [];
  const findFile = (path: string) => files.find(file => path.endsWith('/' + file.name))!;
  mock.method(SftpClient.prototype, 'connect', async (options: any) => { connections.push(options); return true; });
  mock.method(SftpClient.prototype, 'list', async (path: string) => { paths.list.push(path); return files.map(file => ({ name: file.name, type: '-', size: file.buffer.length, modifyTime: file.modified })); });
  mock.method(SftpClient.prototype, 'stat', async (path: string) => { paths.stat.push(path); const file = findFile(path); return { size: file.buffer.length, modifyTime: file.modified }; });
  mock.method(SftpClient.prototype, 'end', async () => true);
  mock.method(SftpClient.prototype, 'get', async (_path: string, stream: any) => { paths.get.push(_path); stream.end(findFile(_path).buffer); return stream; });
  mock.method(globalThis, 'fetch', async (_input: any, init: any) => {
    requests.push({ url: String(_input), init });
    assert.equal(new URL(_input).origin, 'https://openapi.didi-food.com');
    if (init?.method !== 'POST') {
      const shop = new URL(_input).searchParams.get('app_shop_id');
      return new Response(JSON.stringify({ errno: options.authFailShop === shop ? 1 : 0, data: { auth_token: 'private-token:' + shop } }));
    }
    const shop = JSON.parse(init.body).auth_token.split(':')[1];
    assert.equal(uploads.at(-1).status, 'sending', 'audit must be durable before sending');
    posts.push(JSON.parse(init.body));
    if (options.fail || options.uncertainShop === shop) throw new Error('network interrupted');
    return new Response(JSON.stringify({ errno: options.reject || options.rejectShop === shop ? 1 : 0, data: { taskID: '1234567890123456789', auth_token: 'private-token' } }), { status: 200 });
  });
  const prisma: any = {
    brand: { findFirst: async () => ({ country: 'MX' }) },
    application: { findFirst: async () => application },
    sftpApplication: { findFirst: async () => sftpApplication },
    sftpApiRun: {
      updateMany: async ({ where, data }: any) => { if (where.status && where.status !== run.status) return { count: 0 }; Object.assign(run, data); return { count: 1 }; },
      findUniqueOrThrow: async () => run, findUnique: async () => run,
      update: async ({ data }: any) => Object.assign(run, data), count: async () => Number(run.status === 'running'),
    },
    sftpApiProcessedFile: {
      findMany: async ({ where }: any) => records.filter(r => r.ruleId === where.ruleId && (!where.fileName || where.fileName.in.includes(r.fileName))),
      createMany: async ({ data }: any) => { let count = 0; for (const value of data) { if (!records.some(r => r.ruleId === value.ruleId && r.fileName === value.fileName)) { records.push({ id: 'record-' + records.length, ...value }); count++; } } return { count }; },
      update: async ({ where, data }: any) => Object.assign(records.find(r => r.ruleId === where.ruleId_fileName.ruleId && r.fileName === where.ruleId_fileName.fileName), data),
      updateMany: async ({ where, data }: any) => { const selected = records.filter(r => r.runId === where.runId && r.status === where.status); selected.forEach(r => Object.assign(r, data)); return { count: selected.length }; },
    },
    sftpApiRule: { update: async ({ data }: any) => Object.assign(rule, data) },
    sftpApiUpload: {
      count: async ({ where }: any) => where.configHash ? Number(options.previous) : uploads.filter(u => u.status === where.status).length,
      create: async ({ data }: any) => { const value = { status: 'sending', ...data, id: `upload-${uploads.length}` }; uploads.push(value); return value; },
      update: async ({ where, data }: any) => Object.assign(uploads.find(u => u.id === where.id), data),
      updateMany: async ({ where, data }: any) => { uploads.filter(u => u.status === where.status).forEach(u => Object.assign(u, data)); return { count: 1 }; },
    },
    $transaction: async (actions: any[]) => Promise.all(actions),
  };
  const limits: string[] = [];
  const processor = new SftpApiProcessor(prisma, { getOrThrow: () => key } as any, { acquire: async (app: string, shop: string, check: () => Promise<void>) => { await check(); limits.push(app + ':' + shop); return async () => { limits.push('cooldown'); }; } } as any);
  return { processor, prisma, run, rule, uploads, posts, application, sftpApplication, connections, requests, paths, files, records, limits };
}

for (const failure of ['rejectShop', 'authFailShop', 'uncertainShop'] as const) {
  test(`${failure}: later shops continue and the failed store has a durable report`, async () => {
    const h = harness('delta', { [failure]: '0043', files: [{ name: '0043.csv' }, { name: '0044.csv' }] });
    try {
      await h.processor.process({ data: { runId: 'run' } } as any);
      assert.equal(h.run.status, 'partial_failure');
      assert.equal(h.rule.active, true);
      assert.ok(h.uploads.some(u => u.shopId === '0043' && ['failed', 'unknown'].includes(u.status)));
      assert.ok(h.uploads.some(u => u.shopId === '0044' && u.status === 'succeeded'));
      assert.equal(h.records.find(r => r.fileName === '0044.csv').status, 'processed');
      assert.ok(h.records.find(r => r.fileName === '0043.csv').error.includes('0043'));
    } finally { mock.restoreAll(); }
  });
}

test('stores sharing one file continue after one store fails', async () => {
  const h = harness('delta', { rejectShop: '0043', content: '0043|001|3\n0044|002|4' });
  h.rule.shopSource = 'column';
  Object.assign(h.rule.mapping, { app_shop_id: 'A', app_item_id: 'B', stock: 'C' });
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'partial_failure');
    assert.ok(h.uploads.some(u => u.shopId === '0044' && u.status === 'succeeded'));
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].status, 'partial_failure');
  } finally { mock.restoreAll(); }
});

test('age filter includes its cutoff and excludes old, future and nonmatching filenames', async () => {
  const now = Date.now();
  const h = harness('delta', { files: [
    { name: '0043.csv', ageMinutes: 30 }, { name: '0044.csv', ageMinutes: 31 },
    { name: '0045.csv', ageMinutes: -1 }, { name: '0046.txt', ageMinutes: 1 }, { name: '0047.csv', ageMinutes: 0.2 },
  ] });
  h.files[0].modified = now - 30 * 60_000;
  mock.method(Date, 'now', () => now);
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'succeeded');
    assert.deepEqual(h.paths.get.sort(), ['/upload/0043.csv', '/upload/0047.csv']);
    assert.equal(h.records.length, 2);
  } finally { mock.restoreAll(); }
});

for (const mode of ['full', 'delta'] as const) {
  test(`${mode}: same filename stays skipped even with changed content until its record is deleted`, async () => {
    const h = harness(mode);
    try {
      await h.processor.process({ data: { runId: 'run' } } as any);
      const sent = h.posts.length;
      h.files[0].buffer = Buffer.from('001234|Other|||18||8||20');
      h.run.status = 'pending';
      await h.processor.process({ data: { runId: 'run' } } as any);
      assert.equal(h.posts.length, sent);
      assert.equal(h.run.status, 'no_files');
      h.records.splice(0);
      h.run.status = 'pending';
      await h.processor.process({ data: { runId: 'run' } } as any);
      assert.equal(h.posts.length, sent + 1, 'old upload audits must not prevent an explicit file reset');
      assert.equal(h.records[0].status, 'processed');
    } finally { mock.restoreAll(); }
  });
}

test('invalid files are reported without preventing valid files from updating', async () => {
  const h = harness('full', { files: [{ name: '0043.csv', content: 'invalid' }, { name: '0044.csv' }] });
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'partial_failure');
    assert.equal(h.records.find(r => r.fileName === '0043.csv').status, 'failed');
    assert.ok(h.uploads.some(u => u.shopId === '0044' && u.status === 'accepted'));
  } finally { mock.restoreAll(); }
});

test('queued runs use the current application root for listing, download and stat, ignoring legacy folder', async () => {
  const h = harness('delta');
  Object.assign(h.run.snapshot, { folder: '/old-integration-folder' });
  h.sftpApplication.rootPath = ' /new-root/catalog/../stock/ ';
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'succeeded');
    assert.deepEqual(h.paths.list, ['/new-root/stock/']);
    assert.deepEqual(h.paths.get, ['/new-root/stock/0043.csv']);
    assert.deepEqual(h.paths.stat, h.paths.get);
  } finally { mock.restoreAll(); }
});

for (const rootPath of [null, '', '   ']) {
  test(`empty application root ${JSON.stringify(rootPath)} uses the existing /upload default`, async () => {
    const h = harness('delta');
    h.sftpApplication.rootPath = rootPath;
    try {
      await h.processor.process({ data: { runId: 'run' } } as any);
      assert.equal(h.run.status, 'succeeded');
      assert.deepEqual(h.paths.list, ['/upload']);
      assert.deepEqual(h.paths.get, ['/upload/0043.csv']);
    } finally { mock.restoreAll(); }
  });
}

test('invalid application root fails before connecting to SFTP', async () => {
  const h = harness('delta');
  h.sftpApplication.rootPath = 'relative/path';
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'failed');
    assert.equal(h.connections.length, 0);
    assert.equal(h.requests.length, 0);
  } finally { mock.restoreAll(); }
});

test('full sends signed menu+stock and stores exact encrypted body and redacted public JSON', async () => {
  const h = harness('full');
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'accepted');
    assert.equal(h.posts[0].merge_policy, 1);
    assert.equal(h.posts[0].items[0].stock, 7);
    assert.deepEqual(JSON.parse(decrypt(h.uploads[0].encryptedBody, key)), h.posts[0]);
    assert.equal(h.uploads[0].payload.auth_token, '<redacted>');
    assert.equal(h.uploads[0].response.data.auth_token, '<redacted>');
    assert.equal(h.uploads[0].taskId, '1234567890123456789');
    assert.match(h.uploads[0].sentAtMx, /America\/Mexico_City/);
  } finally { mock.restoreAll(); }
});
test('delta submits only stock_list and chunks 2001 items into 2000+1', async () => {
  const h = harness('delta', { content: Array.from({ length: 2001 }, (_, i) => `${i}||||||${i}`).join('\n') });
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'succeeded');
    assert.equal(h.posts.length, 2);
    assert.deepEqual(Object.keys(h.posts[0]).sort(), ['auth_token', 'stock_list']);
    assert.equal(h.posts[0].stock_list.length, 2000);
    assert.deepEqual(h.limits, ['app:0043', 'cooldown', 'app:0043', 'cooldown']);
    assert.equal(h.posts[1].stock_list.length, 1);
    assert.deepEqual(h.posts[0].stock_list[0], { app_item_id: '0', stock: 0 });
    assert.ok(h.uploads.every(u => u.endpoint.endsWith('/setstockSync')));
  } finally { mock.restoreAll(); }
});
test('duplicate report is saved while the cheapest row is sent successfully', async () => {
  const h = harness('delta', { content: '001|Leche|||18||7||20\n001|Leche|||15||2||20' });
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'succeeded');
    assert.equal(h.posts[0].stock_list.length, 1);
    assert.equal(h.posts[0].stock_list[0].stock, 2);
    assert.equal(h.records[0].status, 'processed');
    assert.match(h.records[0].error, /Duplicado 001/);
    assert.match(h.records[0].error, /fila 2/);
  } finally { mock.restoreAll(); }
});

test('already recorded filenames are skipped before downloading or authenticating', async () => {
  const h = harness('delta', { previous: true });
  try { await h.processor.process({ data: { runId: 'run' } } as any); assert.equal(h.posts.length, 0); assert.equal(h.paths.get.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.run.status, 'no_files'); }
  finally { mock.restoreAll(); }
});
test('network uncertainty retains audit and file marker without pausing other stores', async () => {
  const h = harness('full', { fail: true });
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'partial_failure'); assert.equal(h.rule.active, true); assert.equal(h.records[0].status, 'needs_review');
    assert.equal(h.uploads[0].status, 'unknown'); assert.equal(h.posts.length, 1);
  } finally { mock.restoreAll(); }
});
test('interrupted worker is marked for review without replaying remote calls', async () => {
  const h = harness('full', { interrupted: true });
  try { await h.processor.process({ data: { runId: 'run' } } as any); assert.equal(h.run.status, 'needs_review'); assert.equal(h.posts.length, 0); }
  finally { mock.restoreAll(); }
});
test('invalid file does not authenticate or submit partial menus', async () => {
  const h = harness('full', { content: 'bad|incomplete' });
  try { await h.processor.process({ data: { runId: 'run' } } as any); assert.equal(h.run.status, 'partial_failure'); assert.equal(h.records[0].status, 'failed'); assert.equal(h.uploads.length, 0); assert.equal(h.posts.length, 0); }
  finally { mock.restoreAll(); }
});
test('business rejection is recorded and stops subsequent stock batches', async () => {
  const h = harness('delta', { reject: true, content: Array.from({ length: 2001 }, (_, i) => `${i}||||||${i}`).join('\n') });
  try { await h.processor.process({ data: { runId: 'run' } } as any); assert.equal(h.run.status, 'partial_failure'); assert.equal(h.uploads[0].status, 'failed'); assert.equal(h.posts.length, 1); }
  finally { mock.restoreAll(); }
});


test('queued runs resolve rotated catalog credentials, without secrets in snapshots', async () => {
  const h = harness('delta');
  h.application.appSecret = encrypt('rotated-api-secret', key);
  h.sftpApplication.password = encrypt('rotated-sftp-secret', key);
  h.sftpApplication.host = 'rotated.example.test';
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'succeeded');
    assert.equal(h.connections[0].password, 'rotated-sftp-secret');
    assert.equal(h.connections[0].host, 'rotated.example.test');
    const auth = new URL(h.requests[0].url);
    assert.equal(auth.searchParams.get('app_secret'), 'rotated-api-secret');
    assert.equal(auth.searchParams.get('app_id'), 'app');
    const post = h.requests.find(r => r.init?.method === 'POST');
    assert.equal(post.init.headers['didi-header-sign'], createHash('md5').update(post.init.body + 'rotated-api-secret').digest('hex'));
    assert.ok(!('password' in h.run.snapshot));
    assert.ok(!('appSecret' in h.run.snapshot));
  } finally { mock.restoreAll(); }
});

for (const unavailable of ['application', 'sftpApplication'] as const) {
  test('unavailable ' + unavailable + ' fails before any external request', async () => {
    const h = harness('full');
    h.prisma[unavailable].findFirst = async () => null;
    try {
      await h.processor.process({ data: { runId: 'run' } } as any);
      assert.equal(h.run.status, 'failed');
      assert.equal(h.connections.length, 0);
      assert.equal(h.requests.length, 0);
    } finally { mock.restoreAll(); }
  });
}

test('invalid encrypted credentials finish the run instead of leaving it running', async () => {
  const h = harness('full');
  h.application.appSecret = 'invalid';
  try {
    await h.processor.process({ data: { runId: 'run' } } as any);
    assert.equal(h.run.status, 'failed');
    assert.equal(h.connections.length, 0);
    assert.equal(h.requests.length, 0);
  } finally { mock.restoreAll(); }
});
