import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CatalogSyncService } from '../src/catalog/catalog-sync.service';

test('catalog store-detail sync makes zero DiDi calls while the application has a live emergency', async t => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('DiDi must not be called during an emergency');
  }) as typeof fetch;

  const prisma = {
    brand: {
      findUnique: async () => ({
        id: 'brand-1',
        brandName: 'Protected brand',
        deletedAt: null,
        application: { id: 'application-1', appId: 'app-1', appSecret: 'secret' },
      }),
    },
    storeEmergency: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.deepEqual(where.brand, { applicationId: 'application-1' });
        assert.equal(where.finishedAt, null);
        return { id: 'emergency-1' };
      },
    },
  };
  const service = new CatalogSyncService(prisma as never, { get: () => '' } as never);

  await assert.rejects(
    service.syncBrandStores('brand-1'),
    /catalog sync deferred.*active emergency emergency-1/i,
  );
  assert.equal(fetchCalls, 0);
});
