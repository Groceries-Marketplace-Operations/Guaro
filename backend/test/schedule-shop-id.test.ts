import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveScheduleShopIdentifiers } from '../src/queue/handlers/schedule-shop-id.util';

test('schedule updates preserve a 19-digit submitted ID when it may already be an app_shop_id', () => {
  const shops = [{ appShopId: '5764615031694821198' }];

  const result = resolveScheduleShopIdentifiers(shops, new Map());

  assert.deepEqual(shops, [{ appShopId: '5764615031694821198' }]);
  assert.deepEqual(result, { mapped: 0, preserved: ['5764615031694821198'] });
});

test('schedule updates replace a raw shop_id when DiDi returns its app_shop_id mapping', () => {
  const shops = [{ appShopId: '5764615031694821198' }];

  const result = resolveScheduleShopIdentifiers(
    shops,
    new Map([['5764615031694821198', 'promociones-frescas-01']]),
  );

  assert.deepEqual(shops, [{ appShopId: 'promociones-frescas-01' }]);
  assert.deepEqual(result, { mapped: 1, preserved: [] });
});
