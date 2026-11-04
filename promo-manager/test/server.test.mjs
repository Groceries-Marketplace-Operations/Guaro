import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPromoServer } from '../src/server.mjs';

const source = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n'
  + '692|101225082|VINOS Y LICORES|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000001||35.00|||||1\n'
  + '692|101225082|VINOS Y LICORES|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000002||35.00|||||1\n';

async function localServer(t, options = {}) {
  const auditRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'didi-promo-server-test-'));
  const server = createPromoServer({ ...options, auditRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(auditRoot, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('frontend local carga CSV y congela el ID manual en la vista previa', async t => {
  const base = await localServer(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Promo Manager/);
  assert.match(html, /id="bulkTaskProgress"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="bulkTaskPagination"/);
  assert.equal((html.match(/id="sftpAccountSelect"/g) ?? []).length, 1);
  assert.ok(html.indexOf('id="sftpAccountSelect"') < html.indexOf('id="localSource"'));
  assert.match(html, /Marca <small>\(obligatoria\)<\/small>/);

  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(source).toString('base64') }),
  }).then(response => response.json());
  assert.equal(uploaded.stats.promotions, 1);
  assert.equal(uploaded.stats.items, 2);

  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId,
      storeId: 'soriana_929',
      activityIds: ['101225082'],
      types: [2],
      idMode: 'manual',
      newActivityId: '901225082',
      itemIdReplacements: [{ originalId: '7500000000001', sentId: '07500000000999' }],
    }),
  }).then(response => response.json());
  assert.equal(preview.batches.length, 1);
  assert.equal(preview.batches[0].payload.promo_list[0].activity_id, '901225082');
  assert.equal(preview.batches[0].payload.promo_list[0].activity_name, '901225082 · VINOS Y LICORES');
  assert.equal(preview.batches[0].payload.promo_list[0].item_activity_list.length, 2);
  assert.equal(preview.batches[0].payload.promo_list[0].item_activity_list[0].app_item_id, '07500000000999');
  assert.deepEqual(preview.selection.itemIdReplacement.mappings, [
    { originalId: '7500000000001', sentId: '07500000000999', occurrences: 1 },
  ]);
  assert.deepEqual(preview.selection.activityIdReplacement.mappings, [
    { originalId: '101225082', sentId: '901225082' },
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(preview.auditDirectory, 'manifest.json'), 'utf8'));
  const requestLog = JSON.parse(await fs.readFile(path.join(preview.auditDirectory, 'request.json'), 'utf8'));
  const stopInventory = JSON.parse(await fs.readFile(path.join(preview.auditDirectory, 'promociones_para_detener.json'), 'utf8'));
  const events = await fs.readFile(path.join(preview.auditDirectory, 'eventos.jsonl'), 'utf8');
  assert.equal(manifest.status, 'preview_generated');
  assert.equal(manifest.source.fileName, 'promo.csv');
  assert.match(manifest.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(requestLog.jobs[0].payload.promo_list[0].activity_name, '901225082 · VINOS Y LICORES');
  assert.equal(requestLog.jobs[0].payload.auth_token, '{{auth_token}}');
  assert.deepEqual(stopInventory.stores[0].stopRequests[0].promo_list, [{ action: 2, activity_id: '901225082' }]);
  assert.match(events, /"event":"preview_generated"/);
  assert.equal(events.includes('auth_token'), false);
});

test('la auditoría web registra cada intento, respuesta y Task ID sin persistir el token', async t => {
  const token = 'token-secreto-auditoria-929';
  const taskId = '5764670000000000999';
  const calls = [];
  const provider = {
    configured: true,
    authConfigured: true,
    async getAuthTokens(stores) {
      return new Map(stores.map(store => [store.id, token]));
    },
  };
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(`{"errno":0,"data":{"task_id":${taskId}}}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const base = await localServer(t, {
    sorianaSftp: provider,
    apiUrl: 'https://example.test/v1/promo/promo/uploadGroceryPromo',
    fetchImpl,
  });
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(source).toString('base64') }),
  }).then(response => response.json());
  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  const outcome = await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: preview.previewId, authToken: token }),
  }).then(response => response.json());
  assert.equal(outcome.acceptedBatches, 1);
  assert.equal(outcome.outputDirectory, preview.auditDirectory);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth_token, token);

  const files = ['manifest.json', 'request.json', 'promociones_para_detener.json', 'eventos.jsonl', 'result.json'];
  const auditText = (await Promise.all(files.map(file => fs.readFile(path.join(preview.auditDirectory, file), 'utf8')))).join('\n');
  const manifest = JSON.parse(await fs.readFile(path.join(preview.auditDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'send_completed');
  assert.match(auditText, new RegExp(taskId));
  assert.match(auditText, /"status":"sending"/);
  assert.match(auditText, /"status":"accepted"/);
  assert.equal(auditText.includes(token), false);
});

test('frontend exige elegir cuál mecánica conservar cuando un UPC se repite', async t => {
  const duplicateSource = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n'
    + '692|MXDIDI160|Promoción escalonada|2026-10-30 00:00:00|2026-11-05 23:59:00|8|7502275701666|||||2|18|1\n'
    + '692|MXDIDI160|Promoción escalonada|2026-10-30 00:00:00|2026-11-05 23:59:00|8|7502275701666|||||3|24|1\n';
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'duplicados.csv', contentBase64: Buffer.from(duplicateSource).toString('base64') }),
  }).then(response => response.json());
  assert.equal(uploaded.stats.items, 1);
  assert.equal(uploaded.duplicateItemConflicts.length, 1);
  assert.deepEqual(uploaded.duplicateItemConflicts[0].candidates.map(candidate => candidate.row), [2, 3]);

  const request = {
    sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['MXDIDI160'], types: [8],
  };
  const missing = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }).then(response => response.json());
  assert.match(missing.error, /Elige qué fila conservar para el UPC 7502275701666/);

  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, duplicateItemSelections: [{ conflictId: 'duplicate-1', row: 3 }] }),
  }).then(response => response.json());
  assert.deepEqual(preview.batches[0].payload.promo_list[0].item_activity_list, [
    { app_item_id: '7502275701666', bxgy_x: 3, bxgy_y: 2400 },
  ]);
  assert.deepEqual(preview.selection.duplicateItemResolution.mappings, [{
    conflictId: 'duplicate-1', sourceShopId: '692', activityId: 'MXDIDI160', sku: '7502275701666', selectedRow: 3, discardedRows: [2],
  }]);
});

test('frontend permite omitir o conservar explícitamente descuentos de cero por ciento', async t => {
  const zeroSource = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n'
    + '692|MXDIDI182|Descuentos YZA|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000001||0|||||1\n'
    + '692|MXDIDI182|Descuentos YZA|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000002||20|||||1\n';
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'cero.csv', contentBase64: Buffer.from(zeroSource).toString('base64') }),
  }).then(response => response.json());
  assert.equal(uploaded.zeroDiscountItems.length, 1);
  const request = { sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['MXDIDI182'], types: [2] };
  const missing = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }).then(response => response.json());
  assert.match(missing.error, /Elige si se omite o se conserva 1 producto con descuento de 0%/);

  const kept = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, zeroDiscountPolicy: 'keep' }),
  }).then(response => response.json());
  assert.deepEqual(kept.batches[0].payload.promo_list[0].item_activity_list.map(item => item.discount_perc), [0, 20]);
  assert.deepEqual(kept.selection.zeroDiscountResolution, { policy: 'keep', affectedItems: 1, omittedItems: 0, rows: [2] });

  const omitted = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, zeroDiscountPolicy: 'omit' }),
  }).then(response => response.json());
  assert.deepEqual(omitted.batches[0].payload.promo_list[0].item_activity_list.map(item => item.discount_perc), [20]);
  assert.deepEqual(omitted.selection.zeroDiscountResolution, { policy: 'omit', affectedItems: 1, omittedItems: 1, rows: [2] });
});

test('frontend exige omitir porcentajes fuera del rango aceptado por DiDi', async t => {
  const percentageSource = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n'
    + '692|MXDIDI182|Descuentos YZA|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000001||4|||||1\n'
    + '692|MXDIDI182|Descuentos YZA|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000002||20|||||1\n'
    + '692|MXDIDI182|Descuentos YZA|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000003||100|||||1\n';
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'porcentajes.csv', contentBase64: Buffer.from(percentageSource).toString('base64') }),
  }).then(response => response.json());
  assert.deepEqual(uploaded.unsupportedPercentageItems.map(item => item.discountPercentage), [4, 100]);
  const request = { sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['MXDIDI182'], types: [2] };
  const missing = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }).then(response => response.json());
  assert.match(missing.error, /DiDi solo admite discount_perc enteros de 5 a 99/);

  const omitted = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, unsupportedPercentagePolicy: 'omit' }),
  }).then(response => response.json());
  assert.deepEqual(omitted.batches[0].payload.promo_list[0].item_activity_list, [
    { app_item_id: '7500000000002', discount_perc: 20 },
  ]);
  assert.deepEqual(omitted.selection.unsupportedPercentageResolution, {
    policy: 'omit', affectedItems: 2, omittedItems: 2, rows: [2, 4], values: { 4: 1, 100: 1 },
  });
});

test('frontend permite elegir activity action y app_item_id_type de forma segura', async t => {
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(source).toString('base64') }),
  }).then(response => response.json());
  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['101225082'],
      types: [2], activityAction: 2, appItemIdType: 0, idMode: 'keep',
    }),
  }).then(response => response.json());
  assert.equal(preview.selection.activityAction, 2);
  assert.equal(preview.totals.items, 0);
  assert.equal(preview.batches[0].payload.app_item_id_type, 0);
  assert.deepEqual(preview.batches[0].payload.promo_list, [{ action: 2, activity_id: '101225082' }]);

  const invalid = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, storeId: 'soriana_929', activityIds: ['101225082'],
      types: [2], activityAction: 2, appItemIdType: 1, idMode: 'manual', newActivityId: '999',
    }),
  }).then(response => response.json());
  assert.match(invalid.error, /No hay promociones con action 1/);
});

test('frontend congela actions 1 y 2 dentro del mismo JSON', async t => {
  const mixedSource = source
    + '692|101225083|PROMO POR DETENER|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000003||20.00|||||1\n';
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(mixedSource).toString('base64') }),
  }).then(response => response.json());
  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, storeId: 'soriana_929',
      activityIds: ['101225082', '101225083'], types: [2], activityAction: 1,
      activityActions: [
        { activityId: '101225082', action: 1 },
        { activityId: '101225083', action: 2 },
      ],
    }),
  }).then(response => response.json());
  assert.equal(preview.selection.activityAction, 'mixed');
  assert.deepEqual(preview.totals.actions, { create: 1, stop: 1 });
  assert.equal(preview.batches.length, 1);
  assert.equal(preview.batches[0].payload.promo_list[0].item_activity_list.length, 2);
  assert.deepEqual(preview.batches[0].payload.promo_list[1], { action: 2, activity_id: '101225083' });
});

test('frontend local lista y carga un archivo elegido del SFTP sin exponer credenciales', async t => {
  const fakeSftp = {
    configured: true,
    async listPromotionAccounts() {
      return [
        { id: 'SorianaPromoProd', name: 'SorianaPromoProd', filePattern: 'promocionesdidi_*.csv' },
        { id: 'YZAPromoProd', name: 'YZAPromoProd', filePattern: 'promocionesdidi_*.csv' },
      ];
    },
    async listFiles({ accountId }) {
      assert.equal(accountId, 'YZAPromoProd');
      return [{ name: 'promocionesdidi_692_20261030050010.csv', sourceShopId: '692', size: Buffer.byteLength(source), loadable: true }];
    },
    async download(fileName, { accountId }) {
      assert.equal(fileName, 'promocionesdidi_692_20261030050010.csv');
      assert.equal(accountId, 'YZAPromoProd');
      return { fileName, buffer: Buffer.from(source) };
    },
  };
  const base = await localServer(t, { sorianaSftp: fakeSftp });
  const config = await fetch(`${base}/api/config`).then(response => response.json());
  assert.equal(config.sftpConfigured, true);
  assert.deepEqual(config.sftpAccounts.map(account => account.id), ['SorianaPromoProd', 'YZAPromoProd']);
  assert.equal(JSON.stringify(config).includes('password'), false);

  const listing = await fetch(`${base}/api/sftp-files?accountId=YZAPromoProd&q=692`).then(response => response.json());
  assert.equal(listing.total, 1);
  const downloaded = await fetch(`${base}/api/sftp-files/download?accountId=YZAPromoProd&fileName=${encodeURIComponent(listing.files[0].name)}`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await downloaded.text(), source);
  const loaded = await fetch(`${base}/api/sftp-files/load`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: listing.files[0].name, accountId: 'YZAPromoProd' }),
  }).then(response => response.json());
  assert.equal(loaded.stats.promotions, 1);
  assert.equal(loaded.fileName, listing.files[0].name);
});

test('diagnóstico automático toma una tienda por marca, continúa ante archivos inválidos y usa caché', async t => {
  const calls = { accounts: 0, lists: 0, downloads: [] };
  const fakeSftp = {
    configured: true,
    async listPromotionAccounts() {
      calls.accounts += 1;
      return [
        { id: 'BrandAProd', name: 'BrandAProd', brandId: 'brand-a', brandName: 'Marca A', stores: [{ appShopId: '692', name: 'Tienda A' }] },
        { id: 'BrandASecondary', name: 'BrandASecondary', brandId: 'brand-a', brandName: 'Marca A', stores: [{ appShopId: '693', name: 'Tienda A secundaria' }] },
        { id: 'BrandBProd', name: 'BrandBProd', brandId: 'brand-b', brandName: 'Marca B', stores: [{ appShopId: '721', name: 'Tienda B' }] },
      ];
    },
    async listFiles({ accountId }) {
      calls.lists += 1;
      if (accountId === 'BrandAProd') return [{ name: 'promos_692.csv', sourceShopId: '692', fileTimestamp: '2026-10-30 05:00:10', size: Buffer.byteLength(source), loadable: true }];
      if (accountId === 'BrandASecondary') return [{ name: 'promos_693.csv', sourceShopId: '693', fileTimestamp: '2026-10-20 05:00:10', size: Buffer.byteLength(source), loadable: true }];
      return [{ name: 'fuera_estandar_721.csv', sourceShopId: '721', fileTimestamp: '2026-10-30 04:00:10', size: 20, loadable: true }];
    },
    async download(fileName, { accountId }) {
      calls.downloads.push(`${accountId}:${fileName}`);
      if (accountId === 'BrandBProd') return { fileName, buffer: Buffer.from('721|solo|tres\n') };
      if (accountId === 'BrandASecondary') return { fileName, buffer: Buffer.from(source.replaceAll('\n692|', '\n693|')) };
      return { fileName, buffer: Buffer.from(source) };
    },
  };
  const base = await localServer(t, {
    sorianaSftp: fakeSftp,
    diagnosticsNow: () => new Date('2026-10-31T12:00:00Z'),
    diagnosticsCacheMs: 60_000,
  });
  const first = await fetch(`${base}/api/diagnostics`).then(response => response.json());
  assert.equal(first.cached, false);
  assert.deepEqual(first.summary, { brands: 2, healthy: 1, warnings: 0, critical: 1, unavailable: 0, anomalies: 1 });
  const brandA = first.results.find(result => result.brandId === 'brand-a');
  assert.equal(brandA.sample.sourceShopId, '692');
  assert.deepEqual(brandA.sampleOptions.map(option => option.sourceShopId), ['692', '693']);
  assert.equal(first.results.find(result => result.brandId === 'brand-b').anomalies[0].code, 'INVALID_STANDARD_FILE');
  assert.deepEqual([...calls.downloads].sort(), ['BrandAProd:promos_692.csv', 'BrandBProd:fuera_estandar_721.csv']);

  const selected = await fetch(`${base}/api/diagnostics/sample`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'BrandASecondary', fileName: 'promos_693.csv' }),
  }).then(response => response.json());
  assert.equal(selected.result.sample.sourceShopId, '693');
  assert.equal(selected.result.sample.storeName, 'Tienda A secundaria');
  assert.equal(selected.result.sampleOptions.length, 2);
  assert.equal(calls.downloads.length, 3);

  const cached = await fetch(`${base}/api/diagnostics`).then(response => response.json());
  assert.equal(cached.cached, true);
  assert.equal(cached.results.find(result => result.brandId === 'brand-a').sample.sourceShopId, '693');
  assert.equal(calls.downloads.length, 3);

  const refreshed = await fetch(`${base}/api/diagnostics?refresh=1`).then(response => response.json());
  assert.equal(refreshed.cached, false);
  assert.equal(calls.downloads.length, 5);
});

test('frontend local agrupa por tipo y vigencia antes de congelar el JSON', async t => {
  const second = source
    + '692|101225083|OTRA PROMO|2026-10-30 00:00:00|2026-11-05 23:59:00|2|7500000000003||25.00|||||1\n';
  const base = await localServer(t);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(second).toString('base64') }),
  }).then(response => response.json());
  const preview = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, storeId: 'soriana_929',
      activityIds: ['101225082', '101225083'], types: [2], idMode: 'manual', newActivityId: '901225082',
      groupSameTypeAndValidity: true,
    }),
  }).then(response => response.json());
  assert.equal(preview.totals.promotionsBeforeGrouping, 2);
  assert.equal(preview.totals.promotions, 1);
  assert.equal(preview.selection.grouping.groups[0].sourceActivityIds.length, 2);
  assert.equal(preview.batches[0].payload.promo_list[0].activity_id, '901225082');
  assert.equal(preview.batches[0].payload.promo_list[0].item_activity_list.length, 3);
});

test('frontend expone ciudades reales del inventario para filtrar tiendas', async t => {
  const base = await localServer(t, { sorianaSftp: {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts(){return [
      { id: 'SorianaPromoProd', name: 'SorianaPromoProd', filePattern: 'promocionesdidi_*.csv' },
      { id: 'YZAPromoProd', name: 'YZAPromoProd', filePattern: 'promocionesdidi_*.csv' },
    ];},
    async getStoreDirectory(){return { brandName: 'Soriana', stores: [
      { appShopId: '929', name: 'Soriana Tlatelolco', city: 'Ciudad de México' },
      { appShopId: '962', name: 'Soriana Centro', city: 'Monterrey' },
    ]};},
  }});
  const config = await fetch(`${base}/api/config`).then(response=>response.json());
  assert.ok(config.cities.includes('Ciudad de México'));
  assert.ok(config.cities.includes('Monterrey'));
  assert.equal(config.stores.find(store=>store.appShopId==='929').city, 'Ciudad de México');
  assert.deepEqual(config.defaultRuleProfiles[0], {
    id: 'soriana', name: 'SorianaPromoProd', activityAction: 1, appItemIdType: 1,
    description: 'Soriana identifica los productos por UPC.',
  });
  assert.deepEqual(config.defaultRuleProfiles[1], {
    id: 'sftp:YZAPromoProd', name: 'YZAPromoProd', activityAction: 1, appItemIdType: 1,
    description: 'Cuenta SFTP de promociones · promocionesdidi_*.csv.',
  });
});

test('la cuenta SFTP limita las tiendas destino a su propia brand', async t => {
  const base = await localServer(t, { sorianaSftp: {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts(){return [
      { id: 'SorianaPromoProd', name: 'SorianaPromoProd', brandId: 'brand-soriana', brandName: 'Soriana MX', filePattern: 'promocionesdidi_*.csv', stores: [
        { shopId: '5764600000000000929', appShopId: '929', name: 'Soriana Tlatelolco', city: 'Ciudad de México' },
      ] },
      { id: 'YZAPromoProd', name: 'YZAPromoProd', brandId: 'brand-yza', brandName: 'Farmacias YZA', filePattern: 'promocionesdidi_*.csv', stores: [
        { shopId: '5764600000000002001', appShopId: '2001', name: 'YZA Centro', city: 'Mérida' },
        { shopId: '5764600000000002002', appShopId: '1G03', name: 'YZA Norte', city: 'Mérida' },
      ] },
    ];},
  }});
  const frontendConfig = await fetch(`${base}/api/config`).then(response => response.json());
  assert.equal(frontendConfig.sftpAccounts.find(account => account.id === 'SorianaPromoProd').storeCount, 1);
  assert.equal(frontendConfig.sftpAccounts.find(account => account.id === 'YZAPromoProd').storeCount, 2);
  assert.deepEqual(
    frontendConfig.stores.filter(store => store.sftpAccountId === 'YZAPromoProd').map(store => store.name),
    ['YZA Centro', 'YZA Norte'],
  );
  assert.ok(frontendConfig.stores.some(store => store.sftpAccountId === 'YZAPromoProd' && store.appShopId === '1G03'));

  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(source).toString('base64') }),
  }).then(response => response.json());
  const yzaStores = frontendConfig.stores.filter(store => store.sftpAccountId === 'YZAPromoProd');
  const missingBrand = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, destinationMode: 'selected', storeIds: [yzaStores[0].id],
      activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  assert.match(missingBrand.error, /marca \/ cuenta SFTP/i);
  const allYza = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, sftpAccountId: 'YZAPromoProd', destinationMode: 'all',
      activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  assert.equal(allYza.destinationCount, 2);
  assert.deepEqual(allYza.stores.map(store => store.id), yzaStores.map(store => store.id));

  const sorianaStore = frontendConfig.stores.find(store => store.sftpAccountId === 'SorianaPromoProd');
  const crossedBrand = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, sftpAccountId: 'YZAPromoProd', destinationMode: 'selected',
      storeIds: [sorianaStore.id], activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  assert.match(crossedBrand.error, /tienda configurada/i);
});

test('frontend puede actualizar desde DiDi las tiendas vinculadas de una cuenta', async t => {
  const account = {
    id: 'YZAPromoProd', name: 'YZAPromoProd', brandId: 'brand-yza', brandName: 'Farmacias YZA',
    filePattern: 'promocionesdidi_*.csv',
    stores: [{ shopId: '5764600000000002001', appShopId: '2001', name: 'YZA Centro', city: 'Mérida' }],
  };
  const base = await localServer(t, { sorianaSftp: {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts(){return [account];},
    async fetchPromotionAccountStores(){return {
      ...account,
      stores: [
        ...account.stores,
        { shopId: '5764600000000002002', appShopId: '1G03', name: 'YZA Norte', city: 'Mérida' },
      ],
    };},
  }});
  const before = await fetch(`${base}/api/config`).then(response => response.json());
  assert.equal(before.sftpAccounts[0].storeCount, 1);
  const refreshed = await fetch(`${base}/api/sftp-accounts/refresh-stores`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'YZAPromoProd' }),
  }).then(response => response.json());
  assert.deepEqual({ stores: refreshed.stores, numeric: refreshed.numericAppShopIds, alphanumeric: refreshed.alphanumericAppShopIds }, {
    stores: 2, numeric: 1, alphanumeric: 1,
  });
  const after = await fetch(`${base}/api/config`).then(response => response.json());
  assert.equal(after.sftpAccounts[0].storeCount, 2);
  assert.ok(after.stores.some(store => store.appShopId === '1G03'));
});

test('automatización YZA toma el archivo más reciente por tienda, filtra tipo 2 y usa el ID indicado', async t => {
  const files = [
    { name: 'promocionesdidi_1A01_20261030010000.csv', sourceShopId: '1A01', modifiedAt: '2026-10-30T01:00:00.000Z', size: 100, loadable: true },
    { name: 'promocionesdidi_1A01_20261031030000.csv', sourceShopId: '1A01', modifiedAt: '2026-10-31T03:00:00.000Z', size: 100, loadable: true },
    { name: 'promocionesdidi_1A02_20261031020000.csv', sourceShopId: '1A02', modifiedAt: '2026-10-31T02:00:00.000Z', size: 100, loadable: true },
  ];
  const csv = appShopId => 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction\n'
    + `${appShopId}|OLD100|Descuento YZA|2026-10-30 00:00:00|2026-11-05 23:59:59|2|7500000000001||20|||||1\n`
    + `${appShopId}|OTHER800|Precio fijo|2026-10-30 00:00:00|2026-11-05 23:59:59|8|7500000000002|||||2|100|1\n`;
  const downloaded = [];
  const tokens = new Map([
    ['brand_ee699348c369_1A01', 'token-yza-1A01'],
    ['brand_ee699348c369_1A02', 'token-yza-1A02'],
  ]);
  const provider = {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts() {
      return [{
        id: 'YZAPromoProd', name: 'YZAPromoProd', brandId: 'brand-yza', brandName: 'Farmacias YZA Grocery_MX', filePattern: 'promocionesdidi_*.csv',
        stores: [
          { shopId: '5764608000000000001', appShopId: '1A01', name: 'YZA Arboleda', city: 'Mérida' },
          { shopId: '5764608000000000002', appShopId: '1A02', name: 'YZA Centro', city: 'Mérida' },
        ],
      }];
    },
    async listFiles({ accountId }) {
      assert.equal(accountId, 'YZAPromoProd');
      return files;
    },
    async downloadMany(fileNames, { accountId }) {
      assert.equal(accountId, 'YZAPromoProd');
      downloaded.push(...fileNames);
      return fileNames.map(fileName => {
        const appShopId = fileName.includes('_1A01_') ? '1A01' : '1A02';
        return { fileName, buffer: Buffer.from(csv(appShopId)) };
      });
    },
    async getAuthTokens(stores) {
      return new Map(stores.map(store => [store.id, tokens.get(store.id)]));
    },
  };
  const apiCalls = [];
  const fetchImpl = async (_url, options) => {
    apiCalls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok', data: { taskID: String(5764670000000000100n + BigInt(apiCalls.length)) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const base = await localServer(t, {
    sorianaSftp: provider,
    apiUrl: 'https://example.test/v1/promo/promo/uploadGroceryPromo',
    fetchImpl,
  });
  await fetch(`${base}/api/config`).then(response => response.json());
  const preview = await fetch(`${base}/api/sftp-automation/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: 'YZAPromoProd', fileMode: 'latest', types: [2],
      newActivityId: '2026110101', updateDates: false, writeSftp: false, sendApi: true,
    }),
  }).then(response => response.json());
  assert.equal(preview.executable, true);
  assert.deepEqual(preview.summary, {
    selectedFiles: 2, readyFiles: 2, blockedFiles: 0, skippedFiles: 0, filesToEdit: 0, storesToSend: 2,
  });
  assert.deepEqual(downloaded.sort(), [
    'promocionesdidi_1A01_20261031030000.csv',
    'promocionesdidi_1A02_20261031020000.csv',
  ]);
  assert.equal(preview.samplePayloads.length, 2);
  assert.equal(preview.samplePayloads.every(item => item.payload.promo_list.length === 1), true);
  assert.equal(preview.samplePayloads.every(item => item.payload.promo_list[0].activity_type === 2), true);
  assert.equal(preview.samplePayloads.every(item => item.payload.promo_list[0].activity_id === '2026110101'), true);

  const result = await fetch(`${base}/api/sftp-automation/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: preview.previewId, confirmed: true }),
  }).then(response => response.json());
  assert.equal(result.api.acceptedBatches, 2);
  assert.equal(result.api.rejectedBatches, 0);
  assert.equal(apiCalls.length, 2);
  assert.deepEqual(new Set(apiCalls.map(call => call.auth_token)), new Set(['token-yza-1A01', 'token-yza-1A02']));
  assert.equal(apiCalls.every(call => call.promo_list[0].activity_id === '2026110101'), true);
});

test('frontend local permite elegir varias tiendas o toda la brand', async t => {
  const base = await localServer(t);
  const config = await fetch(`${base}/api/config`).then(response => response.json());
  const sorianaAccount = config.sftpAccounts.find(account => /soriana/i.test(`${account.name} ${account.brandName ?? ''}`));
  const sorianaStores = config.stores.filter(store => store.sftpAccountId === sorianaAccount.id);
  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'promo.csv', contentBase64: Buffer.from(source).toString('base64') }),
  }).then(response => response.json());

  const selected = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, sftpAccountId: sorianaAccount.id, destinationMode: 'selected',
      storeIds: ['soriana_929', 'soriana_962'], activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  assert.equal(selected.destinationCount, 2);
  assert.equal(selected.previewScope, 'all_destinations');
  assert.equal(selected.batches.length, 2);

  const all = await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: uploaded.sessionId, sftpAccountId: sorianaAccount.id, destinationMode: 'all',
      activityIds: ['101225082'], types: [2],
    }),
  }).then(response => response.json());
  assert.equal(all.destinationCount, sorianaStores.length);
  assert.equal(all.previewScope, 'representative_destination');
  assert.equal(all.batches.length, 1);
  assert.equal(all.totals.requests, sorianaStores.length);
});

test('consulta en lote los Task ID con la credencial correspondiente de cada tienda', async t => {
  const calls = [];
  const provider = {
    configured: true,
    authConfigured: true,
    async getAuthTokens(stores) {
      return new Map(stores.map(store => [store.id, `token-${store.appShopId}`]));
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body });
    const taskId = /"task_id":(\d+)/.exec(options.body)?.[1];
    return new Response(`{"errno":0,"data":{"taskID":${taskId},"status":"success"}}`, {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const base = await localServer(t, { sorianaSftp: provider, apiUrl: 'https://example.test', fetchImpl });
  const taskIds = ['5764670000000000001', '5764670000000000002'];
  const result = await fetch(`${base}/api/query-tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [
      { storeId: 'soriana_929', taskId: taskIds[0], batchNumber: 1 },
      { storeId: 'soriana_962', taskId: taskIds[1], batchNumber: 2 },
    ] }),
  }).then(response => response.json());
  assert.equal(result.total, 2);
  assert.equal(result.queried, 2);
  assert.equal(result.errors, 0);
  assert.deepEqual(result.results.map(item => item.taskId), taskIds);
  assert.deepEqual(result.results.map(item => item.response.data.taskID), taskIds);
  assert.match(calls[0].body, /token-929/);
  assert.match(calls[1].body, /token-962/);
});

test('divide la autenticación de consultas masivas en lotes seguros para Windows', async t => {
  const remoteStores = Array.from({ length: 205 }, (_, index) => ({
    shopId: `5764608000000${String(index).padStart(6, '0')}`,
    appShopId: `Y${String(index + 1).padStart(4, '0')}`,
    name: `YZA ${index + 1}`,
  }));
  const authBatchSizes = [];
  const provider = {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts() {
      return [{
        id: 'YZAPromoProd', name: 'YZAPromoProd', brandName: 'Farmacias YZA',
        filePattern: 'promocionesdidi_*.csv', stores: remoteStores,
      }];
    },
    async getAuthTokens(stores) {
      authBatchSizes.push(stores.length);
      return new Map(stores.map(store => [store.id, `token-${store.appShopId}`]));
    },
  };
  const fetchImpl = async (_url, options) => {
    const taskId = /"task_id":(\d+)/.exec(options.body)?.[1];
    return new Response(`{"errno":0,"data":{"taskID":${taskId},"status":"success"}}`, {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const base = await localServer(t, { sorianaSftp: provider, apiUrl: 'https://example.test', fetchImpl });
  const frontendConfig = await fetch(`${base}/api/config`).then(response => response.json());
  const stores = frontendConfig.stores.filter(store => store.sftpAccountId === 'YZAPromoProd');
  assert.equal(stores.length, 205);

  const result = await fetch(`${base}/api/query-tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: stores.map((store, index) => ({
      storeId: store.id, taskId: String(100000 + index), batchNumber: index + 1,
    })) }),
  }).then(response => response.json());

  assert.deepEqual(authBatchSizes, [100, 100, 5]);
  assert.equal(result.total, 205);
  assert.equal(result.queried, 205);
  assert.equal(result.errors, 0);
});

test('consulta Task IDs como job con progreso incremental y JSON bajo demanda', async t => {
  const provider = {
    configured: true,
    authConfigured: true,
    async getAuthTokens(stores) {
      return new Map(stores.map(store => [store.id, `token-${store.appShopId}`]));
    },
  };
  const fetchImpl = async (_url, options) => {
    const taskId = /"task_id":(\d+)/.exec(options.body)?.[1];
    await new Promise(resolve => setTimeout(resolve, 8));
    return new Response(`{"errno":0,"data":{"taskID":${taskId},"details":[{"errno":200},{"errno":161,"message":"This item does not match any internal item"}]}}`, {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const base = await localServer(t, { sorianaSftp: provider, apiUrl: 'https://example.test', fetchImpl });
  const taskIds = ['5764670000000000101', '5764670000000000102'];
  const startResponse = await fetch(`${base}/api/query-tasks/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [
      { storeId: 'soriana_929', taskId: taskIds[0], batchNumber: 1 },
      { storeId: 'soriana_962', taskId: taskIds[1], batchNumber: 2 },
    ] }),
  });
  assert.equal(startResponse.status, 202);
  let snapshot = await startResponse.json();
  assert.match(snapshot.jobId, /^[0-9a-f-]+$/);
  const updates = [...snapshot.updates];
  let cursor = snapshot.nextCursor;
  for (let attempt = 0; attempt < 100 && snapshot.status === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    snapshot = await fetch(`${base}/api/query-tasks/jobs/${snapshot.jobId}?after=${cursor}`).then(response => response.json());
    updates.push(...snapshot.updates);
    cursor = snapshot.nextCursor;
  }
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.phase, 'complete');
  assert.equal(snapshot.completed, 2);
  assert.equal(snapshot.queried, 2);
  assert.equal(snapshot.errors, 0);
  assert.equal(updates.length, 2);
  assert.deepEqual(new Set(updates.map(item => item.taskId)), new Set(taskIds));
  assert.equal(updates.every(item => item.detailSummary.code200 === 1 && item.detailSummary.incidents === 1), true);
  assert.equal(JSON.stringify(snapshot).includes('auth_token'), false);
  assert.equal(JSON.stringify(updates).includes('response'), false);

  const raw = await fetch(`${base}/api/query-tasks/jobs/${snapshot.jobId}/results/${updates[0].jobIndex}`).then(response => response.json());
  assert.equal(raw.taskId, updates[0].taskId);
  assert.equal(raw.response.data.details.length, 2);
});
