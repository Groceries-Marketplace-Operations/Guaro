import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SftpApiDto } from '../src/sftp-api/sftp-api.dto';
import { groceryPayload, minorUnits, mxDate, nextSchedule, parseFile, ParseConfig, redact, regexMatches } from '../src/sftp-api/sftp-api.util';

const config: ParseConfig = { delimiter: '|', hasHeader: false, shopSource: 'filename', shopRegex: '(\\d{4})\\.csv$',
  mapping: { app_item_id: 'A', upc: 'A', item_name: 'B', activity_price: 'E', stock: 'G', price: 'I' } };
const row = '001234567890|Leche|||18.50||7.9||20.125';

test('delta accepts standard, fully quoted and mixed records without changing IDs', () => {
  const cfg: ParseConfig = { delimiter: '|', hasHeader: true, shopSource: 'column', shopRegex: '', mapping: { app_shop_id: 'A', app_item_id: 'B', stock: 'F' } };
  const standard = 'A19|009800125104|20600|20600|20600|12|        |';
  const expected = parseFile('didiformato\n' + standard, 'A19.CSV', cfg, 'delta');
  assert.deepEqual(parseFile('didiformato\r\n"' + standard + '"\r\n', 'A19.CSV', cfg, 'delta'), expected);
  const mixed = parseFile('didiformato\n' + standard + '\n"' + standard.replace('009800125104', '009800125111') + '"', 'A19.CSV', cfg, 'delta');
  assert.equal(mixed.get('A19')!.size, 2);
  assert.equal(mixed.get('A19')!.get('009800125104')!.stock, 12);
});

test('standard quoted fields preserve embedded delimiters, quotes and newlines', () => {
  const content = row.replace('Leche', '"Leche | ""entera""\n1L"');
  const standard = parseFile(content, '0043.csv', config, 'full');
  assert.equal(standard.get('0043')!.get('001234567890')!.item_name, 'Leche | "entera"\n1L');
  const wrapped = '"' + content.replace(/"/g, '""') + '"';
  assert.deepEqual(parseFile(wrapped, '0043.csv', config, 'full'), standard);
});

test('full preserves store/UPC leading zeros, rounds money exactly and floors stock', () => {
  const stores = parseFile('\ufeff' + row, 'DJ_0043.csv', config, 'full');
  const item = stores.get('0043')!.get('001234567890')!;
  assert.deepEqual(item, { app_item_id: '001234567890', upc: '001234567890', item_name: 'Leche', stock: 7, price: 2013, activity_price: 1850, status: 1 });
  const payload = groceryPayload('0043', [item]);
  assert.equal(payload.merge_policy, 1);
  assert.deepEqual(payload.categories[0].app_item_ids, ['001234567890']);
});
test('full removes the alphanumeric UPC .0 suffix without changing product IDs', () => {
  for (const [input, expected] of [
    ['7702010225109.0', '7702010225109'],
    ['000123456789.0', '000123456789'],
    ['12345678901234567890.0', '12345678901234567890'],
    [' 00123.0 ', '00123'],
    ['00123', '00123'],
    ['0123A.0', '0123A'], ['00A123.0', '00A123'], ['A0A123.0', 'A0A123'],
    ['ABC.0', 'ABC'], ['abc123.0', 'abc123'],
  ]) {
    const content = row.replace('001234567890', input);
    const item = [...parseFile(content, '0043.csv', config, 'full').get('0043')!.values()][0];
    assert.equal(item.upc, expected);
    assert.equal(typeof item.upc, 'string');
    assert.equal(item.app_item_id, input.trim());
    assert.equal(groceryPayload('0043', [item]).items[0].upc, expected);
  }
});

test('full accepts alphanumeric UPCs and preserves letters and leading zeros in the payload', () => {
  for (const upc of ['001ABCdef', 'LECHE', 'PRODUCTO0000123456789', '001234567890']) {
    const content = row.replace('001234567890', upc);
    const item = [...parseFile(content, '0043.csv', config, 'full').get('0043')!.values()][0];
    assert.equal(item.upc, upc);
    assert.equal(groceryPayload('0043', [item]).items[0].upc, upc);
  }
  assert.throws(() => parseFile(row, '0043.csv', { ...config, mapping: { ...config.mapping, upc: 'J' } }, 'full'), /UPC obligatorio/);
});

test('UPC symbols are reported with the row number, including other decimal formats', () => {
  for (const upc of ['.0', 'ABC.0.0', 'ABC-123.0', '123.5', '123.00', '1.23E+12', 'ABC-123', 'ABC_123', 'ABC/123', 'ABC 123', 'ABC@123']) {
    assert.throws(() => parseFile(row.replace('001234567890', upc), '0043.csv', config, 'full'), /Fila 1: UPC inválido/);
  }
});

test('delta only reads ID and stock, ignoring invalid or missing price/menu fields', () => {
  const delta = parseFile('009|0', '0043.csv', { ...config, mapping: { app_item_id: 'A', stock: 'B' } }, 'delta');
  assert.deepEqual([...delta.get('0043')!.values()], [{ app_item_id: '009', stock: 0 }]);
});
test('CSV supports headers, quotes, delimiters in names, and multiple stores from a column', () => {
  const parsed = parseFile('store,id,name,stock,price\r\n0043,001,"Leche, entera",2,10\r\n0044,002,"Pan ""integral""",0,20', 'input.csv', {
    ...config, delimiter: ',', hasHeader: true, shopSource: 'column', mapping: { app_shop_id: 'A', app_item_id: 'B', upc: 'B', item_name: 'C', stock: 'D', price: 'E' },
  }, 'full');
  assert.equal(parsed.get('0043')!.get('001')!.item_name, 'Leche, entera');
  assert.equal(parsed.get('0044')!.get('002')!.item_name, 'Pan "integral"');
  assert.equal(parsed.get('0044')!.get('002')!.status, 2);
});
test('invalid files fail before building any upload', () => {
  for (const content of ['', row.replace('7.9', '-1'), row.replace('20.125', '0'), '"unterminated']) {
    assert.throws(() => parseFile(content, '0043.csv', config, 'full'));
  }
  assert.throws(() => parseFile(row, 'unknown.csv', config, 'full'), /capturar/);
});
test('money rejects unsafe and negative amounts and rounds decimal ties', () => {
  assert.equal(minorUnits('1.005'), 101);
  assert.equal(minorUnits('19.999'), 2000);
  assert.throws(() => minorUnits('-1'));
  assert.throws(() => minorUnits('9999999999999999999'));
});

test('duplicates select the cheapest effective price and its stock in Full and Delta', () => {
  for (const mode of ['full', 'delta'] as const) {
    const reports: string[] = [];
    const cheaper = row.replace('18.50', '15.00').replace('7.9', '3');
    const result = parseFile([row, cheaper, row].join('\n'), '0043.csv', config, mode, reports);
    const item = result.get('0043')!.get('001234567890')!;
    assert.equal(item.stock, 3);
    assert.equal(result.get('0043')!.size, 1);
    assert.equal(reports.length, 2);
    assert.match(reports[0], /fila 2/);
    if (mode === 'delta') assert.deepEqual(Object.keys(item).sort(), ['app_item_id', 'stock']);
    else assert.equal(item.activity_price, 1500);
  }
});

test('first 30000 unique IDs are retained per shop, later duplicates can lower their price', () => {
  const reports: string[] = [];
  const rows = Array.from({ length: 30001 }, (_, i) => `A|${i}|20|8`);
  rows.push('A|0|10|2', 'B|30000|20|9');
  const cfg: ParseConfig = { delimiter: '|', hasHeader: false, shopSource: 'column', shopRegex: '', mapping: { app_shop_id: 'A', app_item_id: 'B', price: 'C', stock: 'D' } };
  const result = parseFile(rows.join('\n'), 'file.csv', cfg, 'delta', reports);
  assert.equal(result.get('A')!.size, 30000);
  assert.equal(result.get('A')!.has('30000'), false);
  assert.equal(result.get('A')!.get('0')!.stock, 2);
  assert.equal(result.get('B')!.size, 1);
  assert.ok(reports.some(r => r.includes('1 filas descartadas')));
  assert.ok(reports.some(r => r.includes('Duplicado 0')));
});

test('delta with no comparable prices keeps first duplicate and reports it', () => {
  const reports: string[] = [];
  const cfg = { ...config, mapping: { app_item_id: 'A', stock: 'B' } };
  const result = parseFile('001|8\n001|2', '0043.csv', cfg, 'delta', reports);
  assert.equal(result.get('0043')!.get('001')!.stock, 8);
  assert.match(reports[0], /sin precios comparables/);
});
test('categories cover all products in batches of at most 3000', () => {
  const items = Array.from({ length: 3001 }, (_, i) => ({ app_item_id: String(i), stock: 1 }));
  const result = groceryPayload('0043', items);
  assert.equal(result.categories.length, 2);
  assert.equal(result.categories[0].app_item_ids.length, 3000);
  assert.equal(result.categories[1].app_item_ids.length, 1);
});
test('Mexico schedule handles minute boundaries and next-day rollover independently of server zone', () => {
  const schedules = [{ time: '08:15', mode: 'full' as const }, { time: '23:45', mode: 'delta' as const }];
  assert.equal(nextSchedule(schedules, new Date('2026-10-07T14:14:59Z')).at.toISOString(), '2026-10-07T14:15:00.000Z');
  assert.equal(nextSchedule(schedules, new Date('2026-10-07T14:15:00Z')).mode, 'delta');
  assert.equal(nextSchedule(schedules, new Date('2026-10-08T05:45:00Z')).at.toISOString(), '2026-10-08T14:15:00.000Z');
  assert.match(mxDate(new Date('2026-10-07T14:15:00Z')), /08:15:00 America\/Mexico_City$/);
});
test('regex preserves capture groups and terminates pathological patterns', () => {
  assert.equal(regexMatches('(\\d{4})\\.csv$', ['test_0043.csv'])[0]![1], '0043');
  assert.throws(() => regexMatches('(a+)+$', ['a'.repeat(100) + '!']), /timed out/);
});

test('regex compilation validates empty batches and enforces the configuration length limit', () => {
  assert.throws(() => regexMatches('[', []), /regular expression/i);
  assert.throws(() => regexMatches('a'.repeat(501), []), /500/);
  assert.throws(() => regexMatches(['a'] as any, []), /texto/);
  assert.equal(regexMatches('a'.repeat(500), []).length, 0);
  // Regex metacharacters remain functional; these are patterns, not literal text.
  assert.equal(regexMatches('^(?:store|shop)_(\\d+)\\.csv$', ['store_0043.csv', 'other.csv'])[0]![1], '0043');
  assert.equal(regexMatches('^(?:store|shop)_(\\d+)\\.csv$', ['other.csv'])[0], null);
});
test('nested API responses redact credentials', () => {
  assert.deepEqual(redact({ data: { auth_token: 'secret', list: [{ app_secret: 'secret', stock: 3 }] } }), { data: { auth_token: '<redacted>', list: [{ app_secret: '<redacted>', stock: 3 }] } });
});
test('DTO requires catalog relations and valid nested schedules', async () => {
  const dto = plainToInstance(SftpApiDto, { brandId: 'bad', applicationId: 'bad', sftpApplicationId: 'bad', schedules: [{ time: '28:70', mode: 'merge' }] });
  const errors = await validate(dto);
  for (const property of ['brandId', 'applicationId', 'sftpApplicationId', 'schedules']) assert.ok(errors.some(e => e.property === property));
});
