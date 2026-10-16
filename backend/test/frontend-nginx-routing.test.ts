import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('frontend Nginx always proxies API assets before static extension matching', async () => {
  const config = await readFile(join(__dirname, '..', '..', 'frontend', 'nginx.conf'), 'utf8');

  assert.match(config, /location\s+\^~\s+\/api\/\s*\{/);
  assert.match(config, /proxy_pass\s+http:\/\/backend:3000\//);
});

test('frontend Nginx keeps the webhook proxy above the bounded backend timeout', async () => {
  const config = await readFile(join(__dirname, '..', '..', 'frontend', 'nginx.conf'), 'utf8');
  const webhookLocation = config.match(/location\s+\/api\/didi-order-webhooks\/\s*\{([\s\S]*?)\n\s*\}/)?.[1];

  assert.ok(webhookLocation, 'the dedicated webhook proxy location must exist');
  assert.match(webhookLocation, /proxy_read_timeout\s+210s\s*;/);
});
