import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { uploadJobs, parseJsonPreservingLargeIntegers } from '../src/uploader.mjs';

const env = { TOKEN_A: 'secret-store-a-12345', TOKEN_B: 'secret-store-b-67890' };

function job(storeId = 'A', batchNumber = 1) {
  return {
    store: { id: storeId, name: `Tienda ${storeId}`, authTokenEnv: `TOKEN_${storeId}`, appItemIdType: 0 },
    batchNumber,
    payload: { auth_token: '{{auth_token}}', app_item_id_type: 0,
      promo_list: [{ action: 1, activity_type: 4, activity_id: `promo-${batchNumber}`,
        item_activity_list: [{ app_item_id: '0012345', buy_num: 1, get_num: 2 }] }] },
  };
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${instance.address().port}/promotions`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function opts(apiUrl, extra = {}) { return { apiUrl, env, delayMs: 0, timeoutMs: 1500, log() {}, ...extra }; }

test('envía en serie, usa token por tienda y no modifica los payloads de vista previa', async t => {
  const requests = [];
  let concurrent = 0;
  let maximum = 0;
  const url = await server(t, async (request, response) => {
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    requests.push({ method: request.method, type: request.headers['content-type'], body: await readBody(request) });
    setTimeout(() => {
      concurrent -= 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errno: 0, data: { task_id: `task-${requests.length}` } }));
    }, 15);
  });
  const jobs = [job('A', 1), job('A', 2), job('B', 1)];
  const before = JSON.stringify(jobs);
  const events = [];
  const result = await uploadJobs(jobs, opts(url, { onResult: async event => events.push(event) }));
  assert.equal(result.acceptedBatches, 3);
  assert.equal(result.stopped, false);
  assert.equal(maximum, 1);
  assert.deepEqual(requests.map(r => r.body.auth_token), [env.TOKEN_A, env.TOKEN_A, env.TOKEN_B]);
  assert.ok(requests.every(r => r.method === 'POST' && r.type === 'application/json'));
  assert.ok(requests.every(r => !Object.hasOwn(r.body, 'shopid')));
  assert.deepEqual(events.map(event => event.status), ['sending', 'accepted', 'sending', 'accepted', 'sending', 'accepted']);
  assert.equal(JSON.stringify(jobs), before);
  assert.ok(!JSON.stringify({ result, events }).includes(env.TOKEN_A));
});

test('envía action 2 con payload mínimo y registra cero productos', async t => {
  let received;
  const url = await server(t, async (request, response) => {
    received = await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ errno: 0, data: { task_id: '123' } }));
  });
  const stopJob = job('A', 1);
  stopJob.payload.promo_list = [{ action: 2, activity_id: '101225082' }];
  const events = [];
  const result = await uploadJobs([stopJob], opts(url, { onResult: async event => events.push(event) }));
  assert.equal(result.acceptedBatches, 1);
  assert.deepEqual(received.promo_list, [{ action: 2, activity_id: '101225082' }]);
  assert.equal(events[0].items, 0);

  stopJob.payload.promo_list[0].activity_name = 'No debe enviarse';
  await assert.rejects(uploadJobs([stopJob], opts('https://example.com')), /payload mínimo/);
});

test('valida los tokens de todos los destinos antes del primer envío', async () => {
  let calls = 0;
  await assert.rejects(uploadJobs([job('A'), job('B')], opts('https://example.com/promotions', {
    env: { TOKEN_A: env.TOKEN_A }, fetchImpl: async () => { calls += 1; },
  })), /TOKEN_B/);
  assert.equal(calls, 0);
});

test('rechaza un request con 500 Activity IDs o 6000 items antes del POST', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json({ errno: 0 }); };
  const tooManyActivities = job('A');
  tooManyActivities.payload.promo_list = Array.from({ length: 500 }, (_, index) => ({
    action: 1, activity_id: String(index), activity_type: 2,
    item_activity_list: [{ app_item_id: `sku-${index}`, discount_perc: 10 }],
  }));
  await assert.rejects(uploadJobs([tooManyActivities], opts('https://example.com', { fetchImpl })), /menos de 500/);
  const tooManyItems = job('A');
  tooManyItems.payload.promo_list[0].item_activity_list = Array.from({ length: 6000 }, (_, index) => ({
    app_item_id: `sku-${index}`, buy_num: 1, get_num: 2,
  }));
  await assert.rejects(uploadJobs([tooManyItems], opts('https://example.com', { fetchImpl })), /menos de 6000/);
  assert.equal(calls, 0);
});

test('rechaza tokens compartidos entre destinos y placeholders', async () => {
  await assert.rejects(uploadJobs([job('A'), job('B')], opts('https://example.com', {
    env: { TOKEN_A: env.TOKEN_A, TOKEN_B: env.TOKEN_A },
  })), /comparten el mismo token/);
  await assert.rejects(uploadJobs([job('A')], opts('https://example.com', {
    env: { TOKEN_A: 'PEGA_AQUI_TOKEN' },
  })), /Falta un token válido/);
});

test('rechaza destinos HTTP remotos, credenciales y query strings', async () => {
  for (const url of ['http://example.com/promotions', 'https://user:pass@example.com', 'https://example.com?token=x']) {
    await assert.rejects(uploadJobs([job()], opts(url)), /URL/);
  }
});

test('errno no aceptado detiene el resto de los lotes, sin reintentar', async t => {
  let calls = 0;
  const url = await server(t, async (request, response) => {
    calls += 1;
    await readBody(request);
    response.end(JSON.stringify({ errno: 1001, errmsg: 'invalid promotion' }));
  });
  const result = await uploadJobs([job('A', 1), job('A', 2), job('B', 1)], opts(url));
  assert.equal(calls, 1);
  assert.equal(result.rejectedBatches, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.results[0].reason, 'api_error');
});

test('continueOnFailure registra el rechazo y continúa con las demás tiendas', async t => {
  let calls = 0;
  const url = await server(t, async (request, response) => {
    calls += 1;
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(calls === 2
      ? { errno: 10005, errmsg: 'rate limited store' }
      : { errno: 0, data: { taskID: String(5_764_674_000_000_000_000n + BigInt(calls)) } }));
  });
  const result = await uploadJobs([job('A', 1), job('A', 2), job('B', 1)], opts(url, { continueOnFailure: true }));
  assert.equal(calls, 3);
  assert.equal(result.acceptedBatches, 2);
  assert.equal(result.rejectedBatches, 1);
  assert.equal(result.unknownBatches, 0);
  assert.equal(result.stopped, false);
  assert.deepEqual(result.results.map(item=>item.status), ['accepted', 'rejected', 'accepted']);
});

test('un rechazo HTTP no se interpreta como aceptación aunque el cuerpo tenga errno 0', async t => {
  const url = await server(t, async (request, response) => {
    await readBody(request);
    response.writeHead(429);
    response.end(JSON.stringify({ errno: 0 }));
  });
  const result = await uploadJobs([job()], opts(url));
  assert.equal(result.rejectedBatches, 1);
  assert.equal(result.results[0].httpStatus, 429);
  assert.equal(result.results[0].reason, 'http_error');
});

test('timeout deja resultado desconocido y no reintenta ni procesa el siguiente lote', async t => {
  let calls = 0;
  const url = await server(t, async request => { calls += 1; await readBody(request); });
  const result = await uploadJobs([job('A', 1), job('A', 2)], opts(url, { timeoutMs: 50 }));
  assert.equal(calls, 1);
  assert.equal(result.unknownBatches, 1);
  assert.equal(result.results[0].reason, 'timeout');
  assert.equal(result.stopped, true);
});

test('JSON inválido o un JSON sin código esperado queda como desconocido', async () => {
  for (const [body, reason] of [['<html>oops</html>', 'invalid_json'], ['{"status":"ok"}', 'unrecognized_response']]) {
    let calls = 0;
    const result = await uploadJobs([job('A', 1), job('A', 2)], opts('https://example.com', {
      fetchImpl: async () => { calls += 1; return new Response(body, { status: 200 }); },
    }));
    assert.equal(result.unknownBatches, 1);
    assert.equal(result.results[0].reason, reason);
    assert.equal(calls, 1);
  }
});

test('los códigos de éxito se comparan estrictamente y la ruta es configurable', async () => {
  const fetchImpl = async () => Response.json({ data: { code: '0' } });
  const rejected = await uploadJobs([job()], opts('https://example.com', {
    fetchImpl, responseSuccessPath: 'data.code', responseSuccessValue: 0,
  }));
  assert.equal(rejected.rejectedBatches, 1);
  const accepted = await uploadJobs([job()], opts('https://example.com', {
    fetchImpl, responseSuccessPath: 'data.code', responseSuccessValue: '0',
  }));
  assert.equal(accepted.acceptedBatches, 1);
});

test('preserva taskID y cualquier entero de 64 bits sin redondear', async () => {
  const exactTaskId = '5764674212125872345';
  const exactNestedId = '9223372036854775807';
  const raw = `{"errno":0,"data":{"taskID":${exactTaskId},"ids":[${exactNestedId}],"small":123}}`;
  assert.deepEqual(parseJsonPreservingLargeIntegers(raw), {
    errno: 0, data: { taskID: exactTaskId, ids: [exactNestedId], small: 123 },
  });
  const result = await uploadJobs([job()], opts('https://example.com', {
    fetchImpl: async () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }),
  }));
  assert.equal(result.acceptedBatches, 1);
  assert.equal(result.results[0].response.data.taskID, exactTaskId);
  assert.equal(typeof result.results[0].response.data.taskID, 'string');
});

test('no sigue redirecciones ni transmite el token al destino de una redirección', async t => {
  let originCalls = 0;
  let targetCalls = 0;
  const target = await server(t, (request, response) => {
    targetCalls += 1;
    response.end('{"errno":0}');
  });
  const origin = await server(t, async (request, response) => {
    originCalls += 1;
    await readBody(request);
    response.writeHead(307, { location: target });
    response.end();
  });
  const result = await uploadJobs([job('A', 1), job('A', 2)], opts(origin));
  assert.equal(originCalls, 1);
  assert.equal(targetCalls, 0);
  assert.equal(result.unknownBatches, 1);
});

test('redacta claves secretas y valores de tokens incrustados en respuestas o errores', async () => {
  const events = [];
  const logs = [];
  const result = await uploadJobs([job()], opts('https://example.com', {
    fetchImpl: async () => Response.json({ errno: 0, auth_token: env.TOKEN_A,
      data: { Authorization: 'Bearer strange', explanation: `received ${env.TOKEN_A}`, password: 'private' } }),
    onResult: async result => events.push(result), log: value => logs.push(value),
  }));
  const output = JSON.stringify({ result, events, logs });
  assert.ok(!output.includes(env.TOKEN_A));
  assert.ok(!output.includes('Bearer strange'));
  assert.ok(!output.includes('private'));
  assert.equal(result.results[0].response.auth_token, '[REDACTED]');
  const failed = await uploadJobs([job()], opts('https://example.com', {
    fetchImpl: async () => { throw new Error(`Failed with ${env.TOKEN_A}`); },
  }));
  assert.ok(!JSON.stringify(failed).includes(env.TOKEN_A));
});

test('un fallo del registro anterior al POST impide el envío', async () => {
  let calls = 0;
  await assert.rejects(uploadJobs([job()], opts('https://example.com', {
    fetchImpl: async () => { calls += 1; return Response.json({ errno: 0 }); },
    onResult: async () => { throw new Error('disk full'); },
  })), /este lote no se envió/);
  assert.equal(calls, 0);
});

test('un fallo al registrar una respuesta detiene siguientes envíos y conserva resumen en el error', async () => {
  let calls = 0;
  await assert.rejects(uploadJobs([job('A', 1), job('A', 2)], opts('https://example.com', {
    fetchImpl: async () => { calls += 1; return Response.json({ errno: 0 }); },
    onResult: async event => { if (event.status === 'accepted') throw new Error('disk full'); },
  })), error => error.summary?.acceptedBatches === 1 && /registrar su resultado/.test(error.message));
  assert.equal(calls, 1);
});

test('rechaza lotes repetidos y discrepancias del catálogo antes de enviar', async () => {
  await assert.rejects(uploadJobs([job(), job()], opts('https://example.com')), /Lote repetido/);
  const different = job();
  different.payload.app_item_id_type = 1;
  await assert.rejects(uploadJobs([different], opts('https://example.com')), /no coincide/);
});

test('lista vacía no requiere credenciales ni realiza solicitudes', async () => {
  assert.deepEqual(await uploadJobs([]), {
    results: [], acceptedBatches: 0, rejectedBatches: 0, unknownBatches: 0, stopped: false,
  });
});
