import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as ExcelJS from 'exceljs';
import JSZip = require('jszip');
import {
  buildCreateStoresWorkbook,
  buildCreateStoresImportTemplate,
  CREATE_STORES_COMPLETION_ACTION,
  CREATE_STORES_RESULT_KIND,
  formatCreateStoresNote,
  isAllowedCreateStoresXlsxMime,
  isCreateStoresCompletionResult,
  parseCreateStoresCompletion,
  parseCreateStoresWorkbook,
  requiresCreateStoresCompletion,
} from '../src/tasks/create-stores-completion';

function validPayload() {
  return {
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores: [
      {
        appShopId: 'APP-0001',
        shopId: '5764607795237028465',
        storeName: 'Tienda Centro',
        coverage: 'Zona Centro',
      },
    ],
  };
}

async function workbookBuffer(
  headers: unknown[],
  rows: unknown[][],
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet 1');
  sheet.addRow(headers);
  rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function zipEndOffset(content: Buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = content.lastIndexOf(signature);
  assert.notEqual(offset, -1, 'test workbook must have a ZIP end record');
  return offset;
}

function firstCentralEntryOffset(content: Buffer) {
  return content.readUInt32LE(zipEndOffset(content) + 16);
}

test('completion requirement supports the action marker and legacy name fallback', () => {
  assert.equal(
    requiresCreateStoresCompletion(CREATE_STORES_COMPLETION_ACTION, 'Any task', 'Any step'),
    true,
  );
  assert.equal(
    requiresCreateStoresCompletion(null, '  CREATE   NEW stores ', ' create   STORES  '),
    true,
  );
  assert.equal(requiresCreateStoresCompletion(undefined, 'Create New Stores', 'Review File'), false);
  assert.equal(requiresCreateStoresCompletion('another_action', 'Another task', 'Create Stores'), false);
});

test('completion result marker only recognizes the expected result kind', () => {
  assert.equal(isCreateStoresCompletionResult(validPayload()), true);
  assert.equal(isCreateStoresCompletionResult({ ...validPayload(), kind: 'another_kind' }), false);
  assert.equal(isCreateStoresCompletionResult(null), false);
  assert.equal(isCreateStoresCompletionResult([]), false);
});

test('completion payload and at least one store row are mandatory', () => {
  for (const payload of [undefined, null, {}, { kind: CREATE_STORES_RESULT_KIND, version: 2 }]) {
    assert.throws(
      () => parseCreateStoresCompletion(payload),
      /App Shop ID, Shop ID, store name, and coverage are required/,
    );
  }

  for (const stores of [undefined, null, {}, []]) {
    assert.throws(
      () => parseCreateStoresCompletion({
        kind: CREATE_STORES_RESULT_KIND,
        version: 1,
        stores,
      }),
      /Add at least one store/,
    );
  }
});

test('every store field is mandatory', async t => {
  const fields = [
    ['appShopId', 'App Shop ID'],
    ['shopId', 'Shop ID'],
    ['storeName', 'Store name'],
    ['coverage', 'Coverage'],
  ] as const;

  for (const [field, label] of fields) {
    await t.test(`${field} rejects a missing value`, () => {
      const payload = validPayload();
      delete (payload.stores[0] as Record<string, unknown>)[field];
      assert.throws(
        () => parseCreateStoresCompletion(payload),
        new RegExp(`${label} is required for store 1`),
      );
    });

    await t.test(`${field} rejects whitespace`, () => {
      const payload = validPayload();
      (payload.stores[0] as Record<string, unknown>)[field] = ' \t  ';
      assert.throws(
        () => parseCreateStoresCompletion(payload),
        new RegExp(`${label} is required for store 1`),
      );
    });
  }
});

test('completion rejects Shop IDs that are not 19 digits beginning with 57', () => {
  for (const shopId of [
    '05764607795237028465',
    '576460779523702846',
    '57646077952370284650',
    '5864607795237028465',
    '576460779523702846X',
  ]) {
    const payload = validPayload();
    payload.stores[0].shopId = shopId;
    assert.throws(
      () => parseCreateStoresCompletion(payload),
      /Shop ID must contain exactly 19 digits and begin with 57 for store 1/,
    );
  }
});

test('XLSX import rejects a text Shop ID outside the DiDi format', async () => {
  const buffer = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', '05764607795237028465', 'Tienda Centro', 'Zona Centro']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(buffer),
    /Shop ID must contain exactly 19 digits and begin with 57 for store 1/,
  );
});

test('completion rows are trimmed and internal whitespace is normalized', () => {
  const result = parseCreateStoresCompletion({
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores: [{
      appShopId: '  APP-0001  ',
      shopId: '  5764607795237028465  ',
      storeName: '  Tienda\t  Centro  ',
      coverage: '  Zona\n  Centro  ',
    }],
  });

  assert.deepEqual(result, {
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores: [{
      appShopId: 'APP-0001',
      shopId: '5764607795237028465',
      storeName: 'Tienda Centro',
      coverage: 'Zona Centro',
    }],
  });
});

test('duplicate App Shop IDs are rejected after normalization', () => {
  const first = validPayload().stores[0];
  assert.throws(
    () => parseCreateStoresCompletion({
      kind: CREATE_STORES_RESULT_KIND,
      version: 1,
      stores: [
        first,
        { ...first, appShopId: `  ${first.appShopId}  `, shopId: '5764607795237028466' },
      ],
    }),
    /App Shop ID APP-0001 is duplicated/,
  );
});

test('duplicate Shop IDs are rejected after normalization', () => {
  const first = validPayload().stores[0];
  assert.throws(
    () => parseCreateStoresCompletion({
      kind: CREATE_STORES_RESULT_KIND,
      version: 1,
      stores: [
        first,
        { ...first, appShopId: 'APP-0002', shopId: `  ${first.shopId}  ` },
      ],
    }),
    /Shop ID 5764607795237028465 is duplicated/,
  );
});

test('note is deterministically derived from all completed stores', () => {
  const result = parseCreateStoresCompletion({
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores: [
      validPayload().stores[0],
      {
        appShopId: 'APP-0002',
        shopId: '5764607795237028466',
        storeName: 'Tienda Norte',
        coverage: 'Zona Norte',
      },
    ],
  });

  assert.equal(
    formatCreateStoresNote(result),
    [
      'Tiendas creadas: 2',
      '- 1. appshopid: APP-0001 | shopid: 5764607795237028465 | nombre de la tienda: Tienda Centro | coverage: Zona Centro',
      '- 2. appshopid: APP-0002 | shopid: 5764607795237028466 | nombre de la tienda: Tienda Norte | coverage: Zona Norte',
    ].join('\n'),
  );
});

test('XLSX export has exact headers and preserves identifiers as strings', async () => {
  const result = parseCreateStoresCompletion({
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores: [{
      appShopId: '0000123400',
      shopId: '5764607795237028465',
      storeName: 'Tienda Centro',
      coverage: 'Zona Centro',
    }],
  });

  const buffer = await buildCreateStoresWorkbook(result);
  assert.ok(buffer.length > 0);

  const workbook = new ExcelJS.Workbook();
  const workbookBytes = Uint8Array.from(buffer).buffer;
  await workbook.xlsx.load(workbookBytes);
  const sheet = workbook.getWorksheet('Tiendas creadas');
  assert.ok(sheet);

  assert.deepEqual(
    [1, 2, 3, 4].map(column => sheet.getCell(1, column).value),
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
  );
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A2').value, '0000123400');
  assert.equal(typeof sheet.getCell('A2').value, 'string');
  assert.equal(sheet.getCell('B2').value, '5764607795237028465');
  assert.equal(typeof sheet.getCell('B2').value, 'string');
  assert.equal(sheet.getCell('C2').value, 'Tienda Centro');
  assert.equal(sheet.getCell('D2').value, 'Zona Centro');
  assert.equal(sheet.getColumn(1).numFmt, '@');
  assert.equal(sheet.getColumn(2).numFmt, '@');
});

test('XLSX import accepts normalized header aliases, ignores blank rows, and preserves text IDs', async () => {
  const buffer = await workbookBuffer(
    ['app_shop_id', 'shop id', 'Nombre', 'Cobertura'],
    [
      ['0000123400', '5764607795237028465', ' Tienda Centro ', ' Zona Centro '],
      ['', '', '', ''],
      ['APP-0002', '5764607795237028466', 'Tienda Norte', 'Zona Norte'],
    ],
  );

  const result = await parseCreateStoresWorkbook(buffer);
  assert.deepEqual(result.stores, [
    {
      appShopId: '0000123400',
      shopId: '5764607795237028465',
      storeName: 'Tienda Centro',
      coverage: 'Zona Centro',
    },
    {
      appShopId: 'APP-0002',
      shopId: '5764607795237028466',
      storeName: 'Tienda Norte',
      coverage: 'Zona Norte',
    },
  ]);
});

test('XLSX import rejects missing and duplicate required headers', async () => {
  const missing = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda'],
    [['APP-1', '5764607795237028465', 'Tienda']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(missing),
    /Missing required XLSX headers: coverage/,
  );

  const duplicate = await workbookBuffer(
    ['appshopid', 'app_shop_id', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', 'APP-1', '5764607795237028465', 'Tienda', 'Zona']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(duplicate),
    /more than one appshopid column/,
  );
});

test('XLSX import rejects partially filled rows', async () => {
  const buffer = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', '', 'Tienda Centro', 'Zona Centro']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(buffer),
    /Shop ID is required for store 1/,
  );
});

test('XLSX import rejects numeric IDs before Excel rounding can be accepted', async () => {
  const numericAppShopId = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [[1234567890123456789, '5764607795237028465', 'Tienda Centro', 'Zona Centro']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(numericAppShopId),
    /appshopid in row 2 must be stored as text/,
  );

  const numericShopId = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', 5764607795237028465, 'Tienda Centro', 'Zona Centro']],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(numericShopId),
    /shopid in row 2 must be stored as text/,
  );
});

test('XLSX import rejects formula and error identifier cells', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet 1');
  sheet.addRow(['appshopid', 'shopid', 'nombre de la tienda', 'coverage']);
  sheet.addRow(['', '5764607795237028465', 'Tienda Centro', 'Zona Centro']);
  sheet.getCell('A2').value = { formula: 'CONCAT("APP", "-1")', result: 'APP-1' };
  const formulaBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    () => parseCreateStoresWorkbook(formulaBuffer),
    /appshopid in row 2 must be plain text/,
  );

  sheet.getCell('A2').value = { error: '#VALUE!' };
  const errorBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    () => parseCreateStoresWorkbook(errorBuffer),
    /appshopid in row 2 must be plain text/,
  );
});

test('XLSX import rejects corrupt input, an empty data set, and more than 1000 stores', async () => {
  await assert.rejects(
    () => parseCreateStoresWorkbook(Buffer.from('not an xlsx')),
    /not a valid XLSX workbook/,
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    /end-of-central-directory record is missing or malformed/,
  );

  const empty = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [],
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(empty),
    /Add at least one store/,
  );

  const tooManyRows = Array.from({ length: 1001 }, (_, index) => [
    `APP-${index}`,
    `5764607795237${index.toString().padStart(6, '0')}`,
    `Tienda ${index}`,
    `Zona ${index}`,
  ]);
  const tooMany = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    tooManyRows,
  );
  await assert.rejects(
    () => parseCreateStoresWorkbook(tooMany),
    /maximum of 1000 stores can be imported/,
  );
});

test('XLSX ZIP inspection rejects excessive entry counts, ZIP64, encryption, and false sizes', async () => {
  const original = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', '5764607795237028465', 'Tienda', 'Zona']],
  );

  const tooManyEntries = Buffer.from(original);
  const tooManyEnd = zipEndOffset(tooManyEntries);
  tooManyEntries.writeUInt16LE(129, tooManyEnd + 8);
  tooManyEntries.writeUInt16LE(129, tooManyEnd + 10);
  await assert.rejects(
    () => parseCreateStoresWorkbook(tooManyEntries),
    /more than 128 entries/,
  );

  const zip64 = Buffer.from(original);
  const zip64End = zipEndOffset(zip64);
  zip64.writeUInt16LE(0xffff, zip64End + 8);
  zip64.writeUInt16LE(0xffff, zip64End + 10);
  await assert.rejects(
    () => parseCreateStoresWorkbook(zip64),
    /ZIP64 archives are not supported/,
  );

  const encrypted = Buffer.from(original);
  const encryptedCentral = firstCentralEntryOffset(encrypted);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 0x0001, encryptedCentral + 8);
  await assert.rejects(
    () => parseCreateStoresWorkbook(encrypted),
    /encrypted ZIP entries are not supported/,
  );

  const unsafeName = Buffer.from(original);
  const unsafeCentral = firstCentralEntryOffset(unsafeName);
  const unsafeLocal = unsafeName.readUInt32LE(unsafeCentral + 42);
  unsafeName[unsafeCentral + 46] = 0x0a;
  unsafeName[unsafeLocal + 30] = 0x0a;
  await assert.rejects(
    () => parseCreateStoresWorkbook(unsafeName),
    /ZIP entry has an unsafe path/,
  );

  const oversizedEntry = Buffer.from(original);
  const oversizedCentral = firstCentralEntryOffset(oversizedEntry);
  oversizedEntry.writeUInt32LE(8 * 1024 * 1024 + 1, oversizedCentral + 24);
  await assert.rejects(
    () => parseCreateStoresWorkbook(oversizedEntry),
    /exceeds the 8 MB uncompressed limit/,
  );

  const falseSize = Buffer.from(original);
  const falseSizeCentral = firstCentralEntryOffset(falseSize);
  const localOffset = falseSize.readUInt32LE(falseSizeCentral + 42);
  const declaredSize = falseSize.readUInt32LE(falseSizeCentral + 24);
  assert.ok(declaredSize > 0);
  falseSize.writeUInt32LE(declaredSize - 1, falseSizeCentral + 24);
  falseSize.writeUInt32LE(declaredSize - 1, localOffset + 22);
  await assert.rejects(
    () => parseCreateStoresWorkbook(falseSize),
    /uncompressed size .* does not match ZIP metadata/,
  );
});

test('XLSX ZIP inspection bounds worksheet entries matched by ExcelJS through a suffix', async () => {
  const original = await workbookBuffer(
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
    [['APP-1', '5764607795237028465', 'Tienda', 'Zona']],
  );
  const zip = await JSZip.loadAsync(original);
  zip.remove('xl/worksheets/sheet1.xml');
  zip.file(
    'xl/worksheets/sheet1.xml.bak',
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">',
      '<c r="A1"/>'.repeat(10_001),
      '</row></sheetData></worksheet>',
    ].join(''),
  );
  const disguisedWorksheet = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  await assert.rejects(
    () => parseCreateStoresWorkbook(disguisedWorksheet),
    /XML entry xl\/worksheets\/sheet1\.xml\.bak contains too many c elements/,
  );
});

test('XLSX import counts populated rows rather than residual formatting', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet 1');
  sheet.addRow(['appshopid', 'shopid', 'nombre de la tienda', 'coverage']);
  sheet.addRow(['APP-1', '5764607795237028465', 'Tienda', 'Zona']);
  sheet.getCell('A5000').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFFFF' },
  };
  const result = await parseCreateStoresWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].appShopId, 'APP-1');
});

test('XLSX import rejects absurd worksheet dimensions even when the distant cell is only styled', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet 1');
  sheet.addRow(['appshopid', 'shopid', 'nombre de la tienda', 'coverage']);
  sheet.addRow(['APP-1', '5764607795237028465', 'Tienda', 'Zona']);
  sheet.getCell('A100001').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFFFF' },
  };
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    () => parseCreateStoresWorkbook(content),
    /excessively large used range/,
  );
});

test('Create Stores XLSX MIME compatibility remains extension-gated by the upload endpoint', () => {
  assert.equal(isAllowedCreateStoresXlsxMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.equal(isAllowedCreateStoresXlsxMime('application/octet-stream'), true);
  assert.equal(isAllowedCreateStoresXlsxMime('application/zip'), true);
  assert.equal(isAllowedCreateStoresXlsxMime(''), true);
  assert.equal(isAllowedCreateStoresXlsxMime(' Application/Zip '), true);
  assert.equal(isAllowedCreateStoresXlsxMime('text/plain'), false);
});

test('Create Stores import template has exact headers and text-formatted ID columns', async () => {
  const template = await buildCreateStoresImportTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(template).buffer);
  const sheet = workbook.worksheets[0];
  assert.ok(sheet);
  assert.deepEqual(
    [1, 2, 3, 4].map(column => sheet.getCell(1, column).value),
    ['appshopid', 'shopid', 'nombre de la tienda', 'coverage'],
  );
  assert.equal(sheet.getColumn(1).numFmt, '@');
  assert.equal(sheet.getColumn(2).numFmt, '@');
  assert.equal(sheet.rowCount, 1, 'the importable worksheet must not contain a sample store');

  const example = workbook.getWorksheet('Ejemplo');
  assert.ok(example);
  assert.equal(typeof example.getCell('A2').value, 'string');
  assert.equal(typeof example.getCell('B2').value, 'string');
  assert.equal(example.getCell('B2').value, '5764607795237028465');
  assert.equal(example.getCell('C2').value, 'Tienda Centro');
});
