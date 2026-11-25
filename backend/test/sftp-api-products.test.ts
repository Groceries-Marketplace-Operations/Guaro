import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appendAdditionalProducts, validateAdditionalProducts } from '../src/sftp-api/sftp-api-products';
import { groceryPayload, Item } from '../src/sftp-api/sftp-api.util';

const product = { app_item_id: '007702085005231', price: 12000, stock: 21 };
const base = (): Item => ({ app_item_id: 'existing', upc: 'existing', item_name: 'Existing', price: 100, stock: 2, status: 1 });
test('additional products use existing Full categories, preserve IDs, multiply price and apply to every store', () => {
  const stores = new Map(['01', '02'].map(shop => [shop, new Map([['existing', base()]])]));
  for (const mode of ['delta', 'full'] as const) {
    appendAdditionalProducts(stores, [product], mode, []);
    for (const [shop, items] of stores) {
      if (mode === 'delta') { assert.equal(items.size, 1); continue; }
      const payload = groceryPayload(shop, [...items.values()]);
      assert.equal(payload.categories.length, 1);
      assert.deepEqual(payload.categories[0].app_item_ids, ['existing', product.app_item_id]);
      assert.deepEqual(items.get(product.app_item_id), { app_item_id: product.app_item_id, upc: product.app_item_id, item_name: product.app_item_id, price: 1200000, stock: 21, status: 1 });
    }
  }
});
test('SFTP duplicate takes precedence and removing additional products leaves the base menu', () => {
  const original = base();
  const stores = new Map([['01', new Map([['existing', original]])]]);
  const reports: string[] = [];
  appendAdditionalProducts(stores, [{ ...product, app_item_id: 'existing' }], 'full', reports);
  assert.equal(stores.get('01')!.get('existing'), original);
  assert.equal(reports.length, 1);
  appendAdditionalProducts(stores, [], 'full', []);
  assert.equal(stores.get('01')!.size, 1);
});
test('reject invalid products and duplicate IDs before persisting', () => {
  for (const input of [null, {}, [null], [{ ...product, price: -1 }], [{ ...product, price: 0.001 }], [{ ...product, price: 1e20 }], [{ ...product, stock: 1.5 }], [{ ...product, stock: -1 }], [{ ...product, app_item_id: 'bad-id' }], [product, product]]) {
    assert.throws(() => validateAdditionalProducts(input));
  }
  assert.deepEqual(validateAdditionalProducts([]), []);
  assert.deepEqual(validateAdditionalProducts([{ ...product, extra: 'discarded' }]), [product]);
});
test('never creates another category for additions or exceeds capacity', () => {
  const items = new Map(Array.from({ length: 3000 }, (_, index) => [String(index), { ...base(), app_item_id: String(index) }]));
  assert.throws(() => appendAdditionalProducts(new Map([['01', items]]), [product], 'full', []), /categorías existentes/);
  assert.equal(items.size, 3000);
});
