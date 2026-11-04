import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { loadPromotions, splitBatches } from '../src/converter.mjs';

const HEADERS = 'shopid|activityid|activityname|startdate|enddate|activitttype|skuid|discountamount|discountpercentage|mxn_n|mxn_m|bxgy_x|bxgy_y|activityaction';
const base = { shopid: '692', activityid: '101207500', activityname: '2 por precio especial ', startdate: '2026-10-29 00:00:00', enddate: '2026-11-30 23:59:00', activitttype: '8', skuid: '0001234567890', discountamount: '', discountpercentage: '', mxn_n: '', mxn_m: '', bxgy_x: '2', bxgy_y: '199', activityaction: '1' };
const columns = HEADERS.split('|');
function row(overrides = {}) { return { ...base, ...overrides }; }
function csv(rows, delimiter = '|', includeHeader = true) {
  const escape = value => /["\r\n|;,\t]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  return [...(includeHeader ? [columns.map(escape).join(delimiter)] : []), ...rows.map(value => columns.map(key => escape(value[key])).join(delimiter))].join('\n') + '\n';
}
async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'didi-converter-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function loadRows(t, rows, options = {}) {
  const directory = await temp(t);
  const filename = path.join(directory, 'promociones.csv');
  await writeFile(filename, csv(rows, options.delimiter ?? '|'));
  return loadPromotions(filename, options);
}

test('Soriana: preserves discontiguous groups, original IDs, per-SKU prices and exact cents', async t => {
  const result = await loadRows(t, [
    row({ bxgy_y: '0.29' }),
    row({ activityid: '101208478', activitttype: '4', activityname: '3X2', skuid: '7500000000001', mxn_n: '2', mxn_m: '3', bxgy_x: '', bxgy_y: '' }),
    row({ skuid: '0001234567891', bxgy_y: '1220.00' }),
    row({ activityid: 'PERCENT', activitttype: '2', skuid: 'ABC-SKU', discountpercentage: '50.00', bxgy_x: '', bxgy_y: '' }),
    row({ shopid: '693', skuid: '0001234567890', bxgy_y: '1.0100' }),
  ]);
  assert.equal(result.promotions.length, 4);
  assert.deepEqual(result.promotions[0].sourceRows, [2, 4]);
  assert.equal(result.promotions[0].payload.activity_id, '101207500');
  assert.equal(result.promotions[0].payload.activity_name, base.activityname);
  assert.equal(result.promotions[0].payload.child_type, 5);
  assert.deepEqual(result.promotions[0].payload.item_activity_list, [
    { app_item_id: '0001234567890', bxgy_x: 2, bxgy_y: 29 },
    { app_item_id: '0001234567891', bxgy_x: 2, bxgy_y: 122000 },
  ]);
  assert.deepEqual(result.promotions[1].payload.item_activity_list[0], { app_item_id: '7500000000001', buy_num: 2, get_num: 3 });
  assert.equal(result.promotions[2].payload.item_activity_list[0].discount_perc, 50);
  assert.equal(result.promotions[3].payload.item_activity_list[0].bxgy_y, 101);
  assert.deepEqual(result.stats, { rows: 5, promotions: 4, items: 5, byType: { 2: { promotions: 1, items: 1 }, 4: { promotions: 1, items: 1 }, 8: { promotions: 2, items: 3 } }, sourceShops: ['692', '693'] });
  assert.deepEqual(result.meta, { fileName: 'promociones.csv', format: 'csv', delimiter: '|' });
});

test('Benavides aliases, CRLF and semicolon delimiter work', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'legacy.csv');
  await writeFile(filename, 'shopid;ActivityID;ActivityName;startdate;enddate;ActivityType;sku;DiscAmount;DiscPercentage;BuyNum;GetNum;BXGY_X;final_discounted_price;Activityaction\r\n4027;472870;ATEKA;2026-01-08 00:00:00;2026-12-31 23:59:59;8;1036060;;;;;2;1220.00;1\r\n');
  const result = await loadPromotions(filename);
  assert.equal(result.meta.delimiter, ';');
  assert.equal(result.promotions[0].payload.item_activity_list[0].bxgy_y, 122000);
});

test('headerless Soriana CSV detects delimiter and keeps the first data row', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'sin-encabezado.csv');
  await writeFile(filename, csv([
    row({ bxgy_y: '0.29' }),
    row({ activityid: '101208478', activitttype: '4', activityname: '3X2', skuid: '7500000000001', mxn_n: '2', mxn_m: '3', bxgy_x: '', bxgy_y: '' }),
  ], '|', false));
  const result = await loadPromotions(filename);
  assert.equal(result.meta.delimiter, '|');
  assert.equal(result.stats.rows, 2);
  assert.equal(result.promotions[0].payload.activity_id, base.activityid);
  assert.deepEqual(result.promotions[0].sourceRows, [1]);
  assert.equal(result.promotions[0].payload.item_activity_list[0].bxgy_y, 29);
});

test('headerless Calimax rows may use zero placeholders in fields unrelated to their activity type', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'calimax-sin-encabezado.csv');
  await writeFile(filename, '721|100021198|MILLER HIGH LIFE 2 x $93|2026-10-01 00:00:00|2026-10-31 00:00:00|8|034100012311|||0|0|2|93.00|1\n');
  const result = await loadPromotions(filename);
  assert.equal(result.stats.items, 1);
  assert.deepEqual(result.promotions[0].payload.item_activity_list[0], { app_item_id: '034100012311', bxgy_x: 2, bxgy_y: 9300 });
});

test('the standard format rejects a 13-column CSV', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'trece-columnas.csv');
  await writeFile(filename, '692,101207500,Oferta,2026-10-29 00:00:00,2026-11-30 23:59:00,8,0001234567890,1,,, ,2,199\n'.replace(',,, ,', ',,,,'));
  await assert.rejects(loadPromotions(filename, { delimiter: ',' }), /formato estándar exige exactamente 14/);
});

test('a 14-column header with different names falls back to the documented column order', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'encabezado-yza.csv');
  const yzaHeader = 'ShopId|activityId|activityDesc|startDate|endDate|activityType|sku |discountAmount|discountPercentage|MxN_N|MxN_M|BXGY_X|BXGY_Y|activityActionType';
  const data = columns.map(key => base[key]).join('|');
  await writeFile(filename, `${yzaHeader}\n${data}\n`);
  const result = await loadPromotions(filename);
  assert.equal(result.stats.rows, 1);
  assert.equal(result.promotions[0].payload.activity_name, base.activityname);
  assert.equal(result.promotions[0].payload.action, 1);
});

test('moneyUnit cents does not scale twice; fractional cent values are rejected', async t => {
  const result = await loadRows(t, [row({ bxgy_y: '19900.00' })], { moneyUnit: 'cents' });
  assert.equal(result.promotions[0].payload.item_activity_list[0].bxgy_y, 19900);
  await assert.rejects(loadRows(t, [row({ bxgy_y: '0.291' })]), /fracciones menores a un centavo/);
  await assert.rejects(loadRows(t, [row({ bxgy_y: '29.1' })], { moneyUnit: 'cents' }), /entero de centavos/);
  await assert.rejects(loadRows(t, [row({ bxgy_y: '9007199254740992' })], { moneyUnit: 'cents' }), /entero seguro/);
});

test('zero-percent rows are preserved as an explicit decision for the preview', async t => {
  const result = await loadRows(t, [row({ activitttype: '2', discountpercentage: '0', bxgy_x: '', bxgy_y: '' })]);
  assert.equal(result.promotions[0].payload.item_activity_list[0].discount_perc, 0);
  assert.deepEqual(result.zeroDiscountItems, [{
    sourceShopId: base.shopid,
    activityId: base.activityid,
    activityType: 2,
    sku: base.skuid,
    row: 2,
    activityName: base.activityname,
  }]);
  assert.equal(result.warnings.find(warning => warning.code === 'ZERO_DISCOUNT_REQUIRES_SELECTION').rows[0], 2);
});

test('percentages rejected by DiDi are preserved for explicit omission', async t => {
  const result = await loadRows(t, [
    row({ activitttype: '2', skuid: '7500000000001', discountpercentage: '4', bxgy_x: '', bxgy_y: '' }),
    row({ activitttype: '2', skuid: '7500000000002', discountpercentage: '100', bxgy_x: '', bxgy_y: '' }),
  ]);
  assert.deepEqual(result.unsupportedPercentageItems.map(item => ({ sku: item.sku, percentage: item.discountPercentage, row: item.row })), [
    { sku: '7500000000001', percentage: 4, row: 2 },
    { sku: '7500000000002', percentage: 100, row: 3 },
  ]);
  assert.deepEqual(result.warnings.find(warning => warning.code === 'UNSUPPORTED_PERCENTAGE_REQUIRES_OMISSION').rows, [2, 3]);
});

test('a SKU can be in several promotions and duplicates within one group require a choice', async t => {
  const result = await loadRows(t, [row(), row({ activityid: 'OTHER' })]);
  assert.equal(result.stats.items, 2);
  assert.equal(result.warnings.find(w => w.code === 'OVERLAPPING_SKUS').sourceShopId, '692');
  const duplicate = await loadRows(t, [row(), row({ bxgy_y: '299' })]);
  assert.equal(duplicate.stats.rows, 2);
  assert.equal(duplicate.stats.items, 1);
  assert.deepEqual(duplicate.duplicateItemConflicts, [{
    id: 'duplicate-1', sourceShopId: '692', activityId: '101207500', activityType: 8, sku: '0001234567890',
    candidates: [
      { row: 2, activityName: base.activityname, item: { app_item_id: '0001234567890', bxgy_x: 2, bxgy_y: 19900 } },
      { row: 3, activityName: base.activityname, item: { app_item_id: '0001234567890', bxgy_x: 2, bxgy_y: 29900 } },
    ],
  }]);
  assert.equal(duplicate.warnings.find(warning => warning.code === 'DUPLICATE_SKU_REQUIRES_SELECTION').rows.join(','), '2,3');
});

test('different names under one Activity ID get a common name while other metadata conflicts fail', async t => {
  const normalized = await loadRows(t, [row(), row({ skuid: 'SECOND', activityname: 'Otro nombre' })]);
  assert.equal(normalized.promotions[0].payload.activity_name, `Promoción ${base.activityid}`);
  assert.deepEqual(normalized.warnings.find(warning => warning.code === 'ACTIVITY_NAME_NORMALIZED'), {
    code: 'ACTIVITY_NAME_NORMALIZED',
    sourceShopId: base.shopid,
    activityId: base.activityid,
    rows: [2, 3],
    message: `2 nombres distintos compartían el Activity ID ${base.activityid}; se usó el nombre común "Promoción ${base.activityid}".`,
  });
  await assert.rejects(loadRows(t, [row(), row({ skuid: 'SECOND', enddate: '2026-12-31 23:59:00' })]), /incompatibles en end_date/);
});

test('required values, unsupported schemas/actions and bad numeric rules fail descriptively', async t => {
  await assert.rejects(loadRows(t, [row({ skuid: '' })]), /campo obligatorio sku/);
  await assert.rejects(loadRows(t, [row({ activitttype: '7' })]), /activity_type 7 no está soportado/);
  await assert.rejects(loadRows(t, [row({ activityaction: '2' })]), /activityaction 2 no está soportado/);
  await assert.rejects(loadRows(t, [row({ activityaction: '0' })]), /activityaction 0 no está soportado/);
  await assert.rejects(loadRows(t, [row({ bxgy_x: '2.5' })]), /debe ser entero/);
  await assert.rejects(loadRows(t, [row({ activitttype: '4', bxgy_x: '', bxgy_y: '', mxn_n: '3', mxn_m: '2' })]), /buy_num debe ser menor/);
  await assert.rejects(loadRows(t, [row({ activitttype: '2', bxgy_x: '', bxgy_y: '', discountpercentage: '50.50' })]), /debe ser entero/);
  await assert.rejects(loadRows(t, [row({ discountamount: '3' })]), /incompatible o no soportado/);
});

test('dates are validated without timezone conversion; invalid or reversed intervals fail', async t => {
  const result = await loadRows(t, [row({ startdate: '2024-02-29T12:30:00' })]);
  assert.equal(result.promotions[0].payload.start_date, '2024-02-29 12:30:00');
  await assert.rejects(loadRows(t, [row({ startdate: '2026-02-29 00:00:00' })]), /fecha o una hora inválida/);
  await assert.rejects(loadRows(t, [row({ startdate: '2026-12-31 00:00:00' })]), /posterior a la final/);
  await assert.rejects(loadRows(t, [row({ startdate: '2026-10-01T00:00:00Z' })]), /sin zona horaria/);
});

test('quoted names, multiline records, headerRow and explicit delimiter work', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'quoted.csv');
  await writeFile(filename, 'Descripción del archivo\n' + csv([row({ activityname: 'Oferta; "especial"\nsegunda línea' })], ';'));
  const result = await loadPromotions(filename, { headerRow: 2, delimiter: ';' });
  assert.equal(result.promotions[0].payload.activity_name, 'Oferta; "especial"\nsegunda línea');
  assert.deepEqual(result.promotions[0].sourceRows, [4]);
});

test('Windows-1252 can be selected explicitly; malformed rows and missing headers fail', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'latin.csv');
  await writeFile(filename, Buffer.from(csv([row({ activityname: 'Promoción' })]), 'latin1'));
  await assert.rejects(loadPromotions(filename), /no usa utf-8/);
  const result = await loadPromotions(filename, { encoding: 'windows-1252' });
  assert.equal(result.promotions[0].payload.activity_name, 'Promoción');
  await writeFile(filename, HEADERS + '\n692|101\n');
  await assert.rejects(loadPromotions(filename), /se encontraron 2 columnas/);
  await writeFile(filename, 'shopid|activityid|activitttype\n692|101|8\n');
  await assert.rejects(loadPromotions(filename, { delimiter: '|' }), /formato estándar exige exactamente 14/);
});

test('XLSX: preserves zero-padded IDs, date wallclock and string IDs beyond 15 digits', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'promociones.xlsx');
  const workbook = XLSX.utils.book_new();
  const item = row({ activityid: '5764616772435837454', skuid: 123, startdate: new Date('2026-10-29T12:34:00Z'), enddate: new Date('2026-11-30T23:59:00Z'), bxgy_y: 0.29 });
  const sheet = XLSX.utils.aoa_to_sheet([columns, columns.map(key => item[key])], { cellDates: true, UTC: true });
  sheet.G2.z = '0000000000000';
  sheet.D2.z = 'yyyy-mm-dd hh:mm:ss';
  sheet.E2.z = 'yyyy-mm-dd hh:mm:ss';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Promociones');
  // Excel normally stores dates as serial numbers plus a number format.
  await writeFile(filename, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: false }));
  const result = await loadPromotions(filename);
  assert.equal(result.promotions[0].payload.activity_id, '5764616772435837454');
  assert.equal(result.promotions[0].payload.item_activity_list[0].app_item_id, '0000000000123');
  assert.equal(result.promotions[0].payload.item_activity_list[0].bxgy_y, 29);
  assert.equal(result.promotions[0].payload.start_date, '2026-10-29 12:34:00');
  assert.equal(result.meta.sheet, 'Promociones');
});

test('XLSX: multiple data sheets require selection, formulas and long numeric IDs are rejected', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'multiple.xlsx');
  const workbook = XLSX.utils.book_new();
  for (const name of ['A', 'B']) {
    const sheet = XLSX.utils.aoa_to_sheet([columns, columns.map(key => row()[key])]);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  await writeFile(filename, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(loadPromotions(filename), /varias hojas/);
  assert.equal((await loadPromotions(filename, { sheet: 'B' })).meta.sheet, 'B');
  workbook.Sheets.B.M2 = { t: 'n', f: '100+99', v: 199 };
  await writeFile(filename, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(loadPromotions(filename, { sheet: 'B' }), /contiene una fórmula/);
  workbook.Sheets.B.M2 = { t: 'n', v: 199 };
  workbook.Sheets.B.G2 = { t: 'n', v: 1234567890123456 };
  await writeFile(filename, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(loadPromotions(filename, { sheet: 'B' }), /más de 15 dígitos/);
});

test('legacy XLS (BIFF8) imports with the same guarantees; scientific-notation IDs fail', async t => {
  const directory = await temp(t);
  const filename = path.join(directory, 'legacy.xls');
  const workbook = XLSX.utils.book_new();
  const item = row({ skuid: 123, bxgy_y: 0.29 });
  const sheet = XLSX.utils.aoa_to_sheet([columns, columns.map(key => item[key])]);
  sheet.G2.z = '0000000000000';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Promociones');
  await writeFile(filename, XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
  const result = await loadPromotions(filename);
  assert.equal(result.meta.format, 'xls');
  assert.equal(result.promotions[0].payload.item_activity_list[0].app_item_id, '0000000000123');
  assert.equal(result.promotions[0].payload.item_activity_list[0].bxgy_y, 29);
  await assert.rejects(loadRows(t, [row({ skuid: '7.501E+12' })]), /notación científica/);
});

test('splitBatches aplica límites por request y permite continuar un Activity ID', () => {
  const groups = [2, 4, 2].map((size, index) => ({ sourceShopId: '692', payload: { activity_id: String(index), item_activity_list: Array.from({ length: size }, (_, n) => ({ app_item_id: `${index}-${n}` })) }, sourceRows: [] }));
  const byItems = splitBatches(groups, 3, 5);
  assert.deepEqual(byItems.map(batch => batch.map(group => group.payload.activity_id)), [['0', '1'], ['1', '2']]);
  assert.deepEqual(byItems.map(batch => batch.reduce((total, group) => total + group.payload.item_activity_list.length, 0)), [5, 3]);
  const byCount = splitBatches(groups, 2, 100);
  assert.deepEqual(byCount.map(batch => batch.length), [2, 1]);
  assert.deepEqual(byCount.flat(), groups);
  const large = [{ sourceShopId: '692', payload: { activity_id: 'large', item_activity_list: Array.from({ length: 7000 }, (_, n) => ({ app_item_id: String(n) })) }, sourceRows: [] }];
  const continued = splitBatches(large);
  assert.deepEqual(continued.map(batch => batch[0].payload.activity_id), ['large', 'large']);
  assert.deepEqual(continued.map(batch => batch[0].payload.item_activity_list.length), [5999, 1001]);
  assert.throws(() => splitBatches(groups, 0, 5999), /maxPromotions debe ser/);
  assert.throws(() => splitBatches(groups, 500, 5999), /menor a 500/);
  assert.throws(() => splitBatches(groups, 499, 6000), /menor a 6000/);
  assert.deepEqual(splitBatches([]), []);
});
