import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const source = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n' +
  '692|101207500|2X199 Shampoo|2026-10-29 00:00:00|2026-11-30 23:59:00|8|0007501|||||2|199|1\n' +
  '692|101208478|3X2 Pastas|2026-10-29 00:00:00|2026-11-30 23:59:00|4|0007502|||2|3|||1\n' +
  '692|101208478|3X2 Pastas|2026-10-29 00:00:00|2026-11-30 23:59:00|4|0007503|||2|3|||1\n' +
  '692|101207436|50% Saba|2026-10-29 00:00:00|2026-11-30 23:59:00|2|0007504||50.00|||||1\n';

async function setup(t, different = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'didi-cli-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'input.csv'), source);
  const conf = { api: { delayMs: 0 }, stores: [
    { id: 'a', authTokenEnv: 'DIDI_TEST_A', sourceShopIds: ['692'], ...(different ? { includeActivityIds: ['101207500'] } : {}) },
    { id: 'b', authTokenEnv: 'DIDI_TEST_B', sourceShopIds: ['692'], ...(different ? { includeActivityIds: ['101208478'] } : {}) },
  ] };
  await fs.writeFile(path.join(dir, 'stores.json'), JSON.stringify(conf));
  return dir;
}

function run(dir, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--file', 'input.csv', ...args], { cwd: dir, env: { ...process.env, DIDI_TEST_A: '', DIDI_TEST_B: '', PROMO_API_URL: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function output(dir) {
  const runs = await fs.readdir(path.join(dir, 'output'));
  assert.equal(runs.length, 1);
  const result = path.join(dir, 'output', runs[0]);
  return { directory: result, manifest: JSON.parse(await fs.readFile(path.join(result, 'manifest.json'), 'utf8')) };
}

async function server(t, response = { errno: 0, errmsg: 'ok' }) {
  const calls = [];
  const instance = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { url: `http://127.0.0.1:${instance.address().port}/promos`, calls };
}

test('CLI default genera JSON tipos4/8 con todos sus SKU y no hace envíos', async t => {
  const dir = await setup(t);
  const result = await run(dir, ['--stores', 'a', '--batch-size', '1']);
  assert.equal(result.code, 0, result.stderr);
  const { directory, manifest } = await output(dir);
  assert.equal(manifest.mode, 'preview');
  assert.equal(manifest.totals.promotions, 2);
  assert.equal(manifest.totals.items, 3);
  assert.equal(manifest.jobs.length, 2);
  const body = JSON.parse(await fs.readFile(path.join(directory, 'tienda_a/lote_002.json'), 'utf8'));
  assert.equal(body.auth_token, '{{auth_token}}');
  assert.equal(body.promo_list[0].activity_id, '101208478');
  assert.equal(body.promo_list[0].activity_name, '101208478 · 3X2 Pastas');
  assert.deepEqual(body.promo_list[0].item_activity_list.map(i => i.app_item_id), ['0007502', '0007503']);
  const stopInventory = JSON.parse(await fs.readFile(path.join(directory, 'promociones_para_detener.json'), 'utf8'));
  assert.deepEqual(stopInventory.stores[0].promotions.map(promotion => promotion.activityId), ['101207500', '101208478']);
  assert.equal(stopInventory.stores[0].stopRequests[0].promo_list.every(promotion => promotion.action === 2), true);
  assert.match(await fs.readFile(path.join(directory, 'eventos.jsonl'), 'utf8'), /"event":"preview_generated"/);
  await assert.rejects(fs.access(path.join(directory, 'resultados.jsonl')));
});

test('CLI envía distintas selecciones a dos tiendas con tokens aislados y registros sin secretos', async t => {
  const dir = await setup(t, true);
  const api = await server(t);
  const result = await run(dir, ['--stores', 'all', '--send'], { PROMO_API_URL: api.url, DIDI_TEST_A: 'token-A-ONLY-123', DIDI_TEST_B: 'token-B-ONLY-456' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls.map(b => [b.auth_token, b.promo_list.map(p => p.activity_id)]), [['token-A-ONLY-123', ['101207500']], ['token-B-ONLY-456', ['101208478']]]);
  const { directory, manifest } = await output(dir);
  assert.equal(manifest.uploadSummary.acceptedBatches, 2);
  const records = await fs.readFile(path.join(directory, 'resultados.jsonl'), 'utf8');
  const auditEvents = await fs.readFile(path.join(directory, 'eventos.jsonl'), 'utf8');
  assert.equal(records.trim().split('\n').length, 4);
  assert.ok(!records.includes('token-A-ONLY-123') && !records.includes('token-B-ONLY-456'));
  assert.ok(!auditEvents.includes('token-A-ONLY-123') && !auditEvents.includes('token-B-ONLY-456'));
  assert.ok(!result.stdout.includes('token-A-ONLY-123'));
});

test('un rechazo API detiene lotes restantes y devuelve código2', async t => {
  const dir = await setup(t);
  const api = await server(t, { errno: 123, errmsg: 'rechazo simulado' });
  const result = await run(dir, ['--stores', 'a', '--batch-size', '1', '--send'], { PROMO_API_URL: api.url, DIDI_TEST_A: 'token-only-A-123' });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(api.calls.length, 1);
  const { manifest } = await output(dir);
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.uploadSummary.rejectedBatches, 1);
});

test('archivo JSON vacío de IDs nunca se convierte en una selección de todas', async t => {
  const dir = await setup(t);
  await fs.writeFile(path.join(dir, 'ids.json'), '[]');
  const result = await run(dir, ['--stores', 'a', '--ids-file', 'ids.json']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /arreglo de cadenas/);
  await assert.rejects(fs.access(path.join(dir, 'output')));
});

test('selección explícitamente vacía de tiendas o IDs falla antes de generar solicitudes', async t => {
  const dir = await setup(t);
  for (const parameter of ['--ids', '--stores']) {
    const result = await run(dir, [parameter, '']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /selección está vacía/);
  }
});

test('lista de IDs y --types all puede incluir tipo2 sin cambiar los IDs fuente', async t => {
  const dir = await setup(t);
  await fs.writeFile(path.join(dir, 'ids.txt'), '101207436\n');
  const result = await run(dir, ['--stores', 'a', '--ids-file', 'ids.txt', '--types', 'all']);
  assert.equal(result.code, 0, result.stderr);
  const { directory, manifest } = await output(dir);
  assert.equal(manifest.totals.promotions, 1);
  const body = JSON.parse(await fs.readFile(path.join(directory, 'tienda_a/lote_001.json'), 'utf8'));
  assert.equal(body.promo_list[0].activity_id, '101207436');
  assert.equal(body.promo_list[0].item_activity_list[0].discount_perc, 50);
});

test('--send requiere destino explícito cuando hay varias tiendas configuradas', async t => {
  const dir = await setup(t);
  const result = await run(dir, ['--send']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Selecciona explícitamente los destinos/);
});

test('--new-id cambia únicamente el ActivityID enviado y conserva el original en el mapeo', async t => {
  const dir = await setup(t);
  const result = await run(dir, ['--stores', 'a', '--ids', '101207436', '--types', 'all', '--new-id', '909090909']);
  assert.equal(result.code, 0, result.stderr);
  const { directory, manifest } = await output(dir);
  const body = JSON.parse(await fs.readFile(path.join(directory, 'tienda_a/lote_001.json'), 'utf8'));
  assert.equal(body.promo_list[0].activity_id, '909090909');
  assert.equal(body.promo_list[0].activity_name, '909090909 · 50% Saba');
  assert.deepEqual(manifest.selection.activityIdReplacement.mappings, [{ originalId: '101207436', sentId: '909090909' }]);
});

test('--random-id genera un ID numérico distinto y --new-id rechaza selecciones múltiples', async t => {
  const dir = await setup(t);
  const randomResult = await run(dir, ['--stores', 'a', '--ids', '101207436', '--types', 'all', '--random-id']);
  assert.equal(randomResult.code, 0, randomResult.stderr);
  const { directory, manifest } = await output(dir);
  const body = JSON.parse(await fs.readFile(path.join(directory, 'tienda_a/lote_001.json'), 'utf8'));
  assert.match(body.promo_list[0].activity_id, /^\d+$/);
  assert.notEqual(body.promo_list[0].activity_id, '101207436');
  assert.equal(manifest.selection.activityIdReplacement.mode, 'random');

  const secondDir = await setup(t);
  const manualResult = await run(secondDir, ['--stores', 'a', '--new-id', '909090909']);
  assert.equal(manualResult.code, 1);
  assert.match(manualResult.stderr, /exactamente una promoción/);
});
