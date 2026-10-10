import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SftpApiStockLimiter } from '../src/sftp-api/sftp-api-stock-limiter';

function harness() {
  let now = 0;
  const entries = new Map<string, { owner: string; expires: number }>();
  const redis = {
    defineCommand: () => {},
    runCommand: async (name: string, [key, owner, ttl]: [string, string, number]) => name === 'sftpStockAcquire'
      ? redis.set(key, owner, 'PX', ttl, 'NX') : redis.eval('', 1, key, owner, ttl),
    set: async (key: string, owner: string, px: string, ttl: number, nx: string) => {
      assert.equal(px, 'PX'); assert.equal(nx, 'NX');
      if ((entries.get(key)?.expires ?? 0) > now) return null;
      entries.set(key, { owner, expires: now + ttl }); return 'OK';
    },
    eval: async (_script: string, _count: number, key: string, owner: string, ttl: number) => {
      const entry = entries.get(key);
      if (entry?.owner === owner && entry.expires > now) entry.expires = now + ttl;
    },
  };
  const create = () => {
    const limiter = new SftpApiStockLimiter({ client: Promise.resolve(redis) } as any);
    (limiter as any).wait = async (ms: number) => { now += ms; };
    return limiter;
  };
  return { create, now: () => now, advance: (ms: number) => { now += ms; } };
}

test('separate workers share the cooldown for a shop; other shops proceed immediately', async () => {
  const h = harness();
  const done = await h.create().acquire('app', 'shop', async () => {});
  h.advance(5000); await done();
  await h.create().acquire('app', 'other', async () => {});
  assert.equal(h.now(), 5000);
  await h.create().acquire('app', 'shop', async () => {});
  assert.equal(h.now(), 65000);
});

test('abandoned request keeps a timeout plus cooldown and cancelled waiters never acquire', async () => {
  const h = harness();
  const oldDone = await h.create().acquire('app', 'shop', async () => {});
  await assert.rejects(h.create().acquire('app', 'shop', async () => { throw new Error('cancelled'); }), /cancelled/);
  const nextDone = await h.create().acquire('app', 'shop', async () => {});
  assert.equal(h.now(), 120000);
  await oldDone(); // Must not shorten the new owner's lease.
  h.advance(1000); await nextDone();
  await h.create().acquire('app', 'shop', async () => {});
  assert.equal(h.now(), 181000);
});
