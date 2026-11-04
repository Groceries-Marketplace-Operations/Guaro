import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

test('configuración de despliegue toma tiendas actuales y no expone credenciales', async () => {
  delete process.env.PROMO_STORES_CONFIG_PATH;
  const { createPromoServer } = await import('../src/server.mjs');
  const server = createPromoServer({ sorianaSftp: {
    configured: true,
    authConfigured: true,
    async listPromotionAccounts() {
      return [{
        id: 'cuenta-de-prueba', name: 'Cuenta de prueba', brandName: 'Marca de prueba',
        stores: [{ shopId: '9000000000000000001', appShopId: 'T1', name: 'Tienda de prueba', city: 'Prueba' }],
      }];
    },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await fetch(`${base}/api/health`).then(response => response.json()), { ok: true });
    const config = await fetch(`${base}/api/config`).then(response => response.json());
    assert.equal(config.stores.length, 1);
    assert.equal(config.stores[0].appShopId, 'T1');
    assert.equal(config.stores[0].sftpAccountId, 'cuenta-de-prueba');
    assert.equal(config.automaticStoreAuthentication, true);
    assert.equal(Object.hasOwn(config.stores[0], 'authToken'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
