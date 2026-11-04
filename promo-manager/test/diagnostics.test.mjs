import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePromotionDataset, DIAGNOSTIC_RULES } from '../src/diagnostics.mjs';

function promotion(id, type, items, overrides = {}) {
  return {
    sourceShopId: '692',
    sourceRows: [2],
    payload: {
      action: 1,
      activity_id: id,
      activity_name: `Promoción ${id}`,
      activity_type: type,
      start_date: '2026-10-30 00:00:00',
      end_date: '2026-11-30 23:59:59',
      item_activity_list: items,
      ...overrides,
    },
  };
}

test('diagnóstico considera sana una muestra estándar dentro de los umbrales', () => {
  const dataset = {
    warnings: [],
    promotions: [promotion('100', 8, [{ app_item_id: '7501234567890', bxgy_x: 2, bxgy_y: 19900 }])],
    stats: { rows: 1, promotions: 1, items: 1, sourceShops: ['692'], byType: {} },
  };
  const result = analyzePromotionDataset(dataset, {
    now: new Date('2026-10-31T12:00:00Z'),
    file: { name: 'promocionesdidi_692_20261030050010.csv', sourceShopId: '692', fileTimestamp: '2026-10-30 05:00:10' },
  });
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.anomalies, []);
  assert.ok(DIAGNOSTIC_RULES.length >= 7);
});

test('diagnóstico agrupa errores del convertidor y valores de negocio atípicos', () => {
  const dataset = {
    warnings: [{ code: 'ZERO_DISCOUNT_REQUIRES_SELECTION', rows: [2, 3], message: '2 filas contienen descuento de 0%.' }],
    promotions: [
      promotion('LOW-PERCENT', 2, [{ app_item_id: 'ABC', discount_perc: 2 }]),
      promotion('HIGH-RATIO', 4, [{ app_item_id: '7501234567890', buy_num: 1, get_num: 30 }]),
      promotion('LOW-PRICE', 8, [{ app_item_id: '7501234567891', bxgy_x: 2, bxgy_y: 150 }]),
    ],
    stats: { rows: 4, promotions: 3, items: 3, sourceShops: ['692'], byType: {} },
  };
  const result = analyzePromotionDataset(dataset, {
    now: new Date('2026-10-31T12:00:00Z'),
    file: { name: 'muestra.csv', sourceShopId: '999', fileTimestamp: '2026-10-01 00:00:00' },
  });
  const codes = new Set(result.anomalies.map(anomaly => anomaly.code));
  assert.equal(result.status, 'critical');
  for (const code of [
    'ZERO_DISCOUNT_REQUIRES_SELECTION', 'FILE_STORE_MISMATCH', 'STALE_FILE',
    'VERY_LOW_PERCENTAGE', 'VERY_HIGH_MXN_QUANTITY', 'VERY_HIGH_MXN_RATIO',
    'VERY_LOW_FIXED_PRICE', 'NON_NUMERIC_ITEM_ID',
  ]) assert.ok(codes.has(code), code);
  assert.equal(result.anomalies.find(anomaly => anomaly.code === 'ZERO_DISCOUNT_REQUIRES_SELECTION').count, 2);
});
