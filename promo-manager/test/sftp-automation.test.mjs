import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPromotions } from '../src/converter.mjs';
import { prepareDatasetForAutomation, rewritePromotionDates } from '../src/sftp-automation.mjs';

const header = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction';

test('edita la vigencia del CSV y vuelve a validarlo antes de usarlo', async t => {
  const source = `${header}\n`
    + '1A01|OLD100|Descuento|2026-10-01 00:00:00|2026-10-31 23:59:59|2|7500000000001||20|||||1\n';
  const rewritten = rewritePromotionDates(Buffer.from(source), 'promocionesdidi_1A01_20261031030000.csv', {
    startDate: '2026-11-01 00:00:00',
    endDate: '2026-11-30 23:59:59',
  });
  assert.equal(rewritten.changedRows, 1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'promo-sftp-automation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.csv');
  await fs.writeFile(file, rewritten.buffer);
  const dataset = await loadPromotions(file, { fileName: 'editado.csv' });
  assert.equal(dataset.promotions[0].payload.start_date, '2026-11-01 00:00:00');
  assert.equal(dataset.promotions[0].payload.end_date, '2026-11-30 23:59:59');
});

test('la automatización de tipo 2 omite porcentajes rechazados y bloquea duplicados contradictorios', () => {
  const dataset = {
    promotions: [{
      sourceShopId: '1A01',
      payload: {
        action: 1, activity_type: 2, activity_id: 'OLD100', activity_name: 'Descuento',
        start_date: '2026-11-01 00:00:00', end_date: '2026-11-30 23:59:59',
        item_activity_list: [
          { app_item_id: 'A', discount_perc: 0 },
          { app_item_id: 'B', discount_perc: 4 },
          { app_item_id: 'C', discount_perc: 20 },
        ],
      },
    }],
    duplicateItemConflicts: [], zeroDiscountItems: [], unsupportedPercentageItems: [], warnings: [],
    stats: { rows: 3, promotions: 1, items: 3, sourceShops: ['1A01'], byType: {} },
  };
  const prepared = prepareDatasetForAutomation(dataset, [2]);
  assert.deepEqual(prepared.dataset.promotions[0].payload.item_activity_list, [{ app_item_id: 'C', discount_perc: 20 }]);
  assert.deepEqual(prepared.rules, {
    duplicateRowsCollapsed: 0,
    zeroPercentItemsOmitted: 1,
    unsupportedPercentItemsOmitted: 1,
  });

  assert.throws(() => prepareDatasetForAutomation({
    ...dataset,
    duplicateItemConflicts: [{
      sourceShopId: '1A01', activityId: 'OLD100', activityType: 2, sku: 'C',
      candidates: [
        { row: 2, item: { app_item_id: 'C', discount_perc: 20 } },
        { row: 3, item: { app_item_id: 'C', discount_perc: 30 } },
      ],
    }],
  }, [2]), /mecánicas diferentes/);
});
