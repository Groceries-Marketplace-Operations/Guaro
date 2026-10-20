import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as ExcelJS from 'exceljs';
import {
  buildCreateBrandImportTemplate,
  buildCreateBrandWorkbook,
  CREATE_BRAND_COMPLETION_ACTION,
  CREATE_BRAND_RESULT_KIND,
  CREATE_NEW_BRAND_TASK_TYPE_ID,
  formatCreateBrandNote,
  isAllowedCreateBrandXlsxMime,
  isCreateBrandCompletionResult,
  parseCreateBrandCompletion,
  parseCreateBrandWorkbook,
  requiresCreateBrandCompletion,
} from '../src/tasks/create-brand-completion';

function validPayload() {
  return {
    kind: CREATE_BRAND_RESULT_KIND,
    version: 1,
    brand: {
      brandName: 'Marca Centro',
      brandId: '5764607795237028465',
    },
  };
}

async function workbookBuffer(headers: unknown[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Marca creada');
  sheet.addRow(headers);
  rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('Create Brand requirement supports action, exact UUID, and exact singular name fallbacks', () => {
  assert.equal(
    requiresCreateBrandCompletion(CREATE_BRAND_COMPLETION_ACTION, null, 'Other', 'Other'),
    true,
  );
  assert.equal(
    requiresCreateBrandCompletion(null, CREATE_NEW_BRAND_TASK_TYPE_ID, 'Renamed', 'Create Brand'),
    true,
  );
  assert.equal(
    requiresCreateBrandCompletion(null, null, '  CREATE   NEW BRAND ', ' create brand '),
    true,
  );
  assert.equal(requiresCreateBrandCompletion(null, null, 'Create New Brands', 'Create Brand'), false);
  assert.equal(requiresCreateBrandCompletion(null, null, 'Create New Brand', 'Review Brand'), false);
});

test('completion payload is versioned, normalized, and contains exactly one brand', () => {
  assert.equal(isCreateBrandCompletionResult(validPayload()), true);
  assert.equal(isCreateBrandCompletionResult({ ...validPayload(), version: 2 }), false);

  const parsed = parseCreateBrandCompletion({
    kind: CREATE_BRAND_RESULT_KIND,
    version: 1,
    brand: { brandName: '  Marca   Centro ', brandId: ' 5764607795237028465 ' },
  });
  assert.deepEqual(parsed.brand, {
    brandName: 'Marca Centro',
    brandId: '5764607795237028465',
  });
  assert.equal(
    formatCreateBrandNote(parsed),
    'Nombre de la marca: Marca Centro | Brand ID: 5764607795237028465',
  );

  for (const invalid of [undefined, null, {}, { ...validPayload(), version: 2 }, { ...validPayload(), brand: [] }]) {
    assert.throws(() => parseCreateBrandCompletion(invalid), /Brand name and Brand ID are required/);
  }
});

test('completion rejects missing fields and Brand IDs outside the 19-digit 57 format', () => {
  assert.throws(
    () => parseCreateBrandCompletion({ ...validPayload(), brand: { ...validPayload().brand, brandName: ' ' } }),
    /Brand name is required/,
  );
  for (const brandId of [
    '',
    '576460779523702846',
    '57646077952370284650',
    '5864607795237028465',
    '576460779523702846X',
  ]) {
    assert.throws(
      () => parseCreateBrandCompletion({ ...validPayload(), brand: { ...validPayload().brand, brandId } }),
      brandId ? /exactly 19 digits and begin with 57/ : /Brand ID is required/,
    );
  }
});

test('XLSX export and import preserve Brand ID as text', async () => {
  const result = parseCreateBrandCompletion(validPayload());
  const exported = await buildCreateBrandWorkbook(result);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(exported).buffer);
  const sheet = workbook.getWorksheet('Marca creada');
  assert.ok(sheet);
  assert.deepEqual([sheet.getCell('A1').value, sheet.getCell('B1').value], ['nombre de la marca', 'brand id']);
  assert.equal(sheet.getCell('A2').value, 'Marca Centro');
  assert.equal(sheet.getCell('B2').value, '5764607795237028465');
  assert.equal(typeof sheet.getCell('B2').value, 'string');
  assert.equal(sheet.getColumn(2).numFmt, '@');

  const imported = await parseCreateBrandWorkbook(exported);
  assert.deepEqual(imported, result);
});

test('XLSX import accepts aliases but requires exactly one populated brand row', async () => {
  const aliases = await workbookBuffer(
    ['Brand Name', 'Brand_ID'],
    [[' Marca Centro ', '5764607795237028465']],
  );
  assert.deepEqual((await parseCreateBrandWorkbook(aliases)).brand, validPayload().brand);

  const multiple = await workbookBuffer(
    ['nombre de la marca', 'brand id'],
    [
      ['Marca Uno', '5764607795237028465'],
      ['Marca Dos', '5764607795237028466'],
    ],
  );
  await assert.rejects(() => parseCreateBrandWorkbook(multiple), /exactly one brand/);

  const empty = await workbookBuffer(['nombre de la marca', 'brand id'], []);
  await assert.rejects(() => parseCreateBrandWorkbook(empty), /Brand name and Brand ID are required/);
});

test('XLSX import rejects numeric identifiers and every non-plain-text populated cell', async () => {
  const numeric = await workbookBuffer(
    ['nombre de la marca', 'brand id'],
    [['Marca Centro', 5764607795237028465]],
  );
  await assert.rejects(() => parseCreateBrandWorkbook(numeric), /must be plain text/);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Marca creada');
  sheet.addRow(['nombre de la marca', 'brand id', 'extra']);
  sheet.addRow(['Marca Centro', '5764607795237028465', '']);
  sheet.getCell('C2').value = { formula: '1+1', result: 2 };
  const formula = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => parseCreateBrandWorkbook(formula), /must be plain text/);
});

test('XLSX template keeps the import sheet empty and an example on a second sheet', async () => {
  const template = await buildCreateBrandImportTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(template).buffer);
  assert.equal(workbook.worksheets[0].rowCount, 1);
  assert.equal(workbook.worksheets[1].getCell('B2').value, '5764607795237028465');
});

test('brand XLSX MIME allowlist is narrow and case-insensitive', () => {
  assert.equal(isAllowedCreateBrandXlsxMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.equal(isAllowedCreateBrandXlsxMime(' Application/Zip '), true);
  assert.equal(isAllowedCreateBrandXlsxMime('application/octet-stream'), true);
  assert.equal(isAllowedCreateBrandXlsxMime('text/plain'), false);
});
