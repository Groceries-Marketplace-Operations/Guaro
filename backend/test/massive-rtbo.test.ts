import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DIDI_BASE } from '../src/queue/handlers/didi-food.util';
import { updatePromiseProduceTime } from '../src/file-integrations/massive-rtbo.util';

test('Massive RTBO sends the documented promise_produce_time shop update contract', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let request: { input?: string | URL | Request; init?: RequestInit } = {};
  global.fetch = (async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ errno: 0, errmsg: 'ok', data: true }), { status: 200 });
  }) as typeof fetch;

  await updatePromiseProduceTime('secret-token', 600);

  assert.equal(String(request.input), `${DIDI_BASE}/v1/shop/shop/update`);
  assert.equal(request.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    auth_token: 'secret-token',
    promise_produce_time: 600,
  });
});

test('Massive RTBO surfaces DiDi business errors without exposing the auth token', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (async () => new Response(JSON.stringify({ errno: 10003, errmsg: 'invalid request' }), { status: 200 })) as typeof fetch;

  await assert.rejects(
    () => updatePromiseProduceTime('must-not-leak', 300),
    (error: Error) => error.message.includes('errno=10003') && !error.message.includes('must-not-leak'),
  );
});
