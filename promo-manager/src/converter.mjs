import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

const ALIASES = {
  sourceShopId: ['shopid', 'shop_id', 'storeid', 'store_id'],
  activityId: ['activityid', 'activity_id'],
  activityName: ['activityname', 'activity_name'],
  startDate: ['startdate', 'start_date'],
  endDate: ['enddate', 'end_date'],
  activityType: ['activitytype', 'activitttype', 'activity_type'],
  sku: ['sku', 'skuid', 'sku_id', 'app_item_id', 'upc'],
  discountAmount: ['discamount', 'discountamount', 'discount_amount'],
  discountPercentage: ['discpercentage', 'discountpercentage', 'discount_perc', 'discount_percentage'],
  buyNum: ['buynum', 'buy_num', 'mxn_n'],
  getNum: ['getnum', 'get_num', 'mxn_m'],
  bxgyX: ['bxgy_x'],
  bxgyY: ['bxgy_y', 'final_discounted_price'],
  action: ['activityaction', 'activity_action', 'action'],
};
const COMMON_FIELDS = ['sourceShopId', 'activityId', 'activityName', 'startDate', 'endDate', 'activityType', 'sku', 'action'];
const IDENTIFIERS = new Set(['sourceShopId', 'activityId', 'sku']);
const DATE_FIELDS = new Set(['startDate', 'endDate']);
const NUMERIC_FIELDS = ['discountAmount', 'discountPercentage', 'buyNum', 'getNum', 'bxgyX', 'bxgyY'];
const CONSISTENT_META_FIELDS = ['action', 'activity_type', 'start_date', 'end_date'];
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const normalizedHeader = value => String(value).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_]+/g, '');
const FIELD_BY_HEADER = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map(name => [normalizedHeader(name), field])));
const HEADERLESS_SCHEMAS = new Map([
  [14, ['sourceShopId', 'activityId', 'activityName', 'startDate', 'endDate', 'activityType', 'sku', 'discountAmount', 'discountPercentage', 'buyNum', 'getNum', 'bxgyX', 'bxgyY', 'action']],
]);

function errorAt(context, message) {
  const position = context?.row ? `, fila ${context.row}` : '';
  return new Error(`${context?.fileName ?? 'Archivo'}${position}: ${message}`);
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isZeroPlaceholder(value) {
  if (typeof value === 'number') return value === 0;
  return typeof value === 'string' && /^0+(?:\.0+)?$/.test(value.trim());
}

function text(value, field, context) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw errorAt(context, `${field} debe contener texto o un número válido.`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw errorAt(context, `${field} no es un número finito.`);
  return String(value);
}

function required(value, field, context) {
  if (isBlank(value)) throw errorAt(context, `falta el campo obligatorio ${field}.`);
  return value;
}

function integer(value, field, context, { allowZero = false } = {}) {
  const original = text(required(value, field, context), field, context).trim();
  const match = /^(\d+)(?:\.(0+))?$/.exec(original);
  if (!match) throw errorAt(context, `${field} debe ser entero positivo (se admite, por ejemplo, 50.00). Valor: ${original}`);
  const result = BigInt(match[1]);
  if (result > MAX_SAFE || result < (allowZero ? 0n : 1n)) throw errorAt(context, `${field} está fuera del rango de enteros admitido.`);
  return Number(result);
}

// Decimal conversion uses digit strings and BigInt, never floating-point multiplication.
function money(value, unit, context) {
  const original = text(required(value, 'bxgy_y / final_discounted_price', context), 'precio', context).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(original);
  if (!match) throw errorAt(context, `el precio debe usar punto decimal, sin moneda ni separadores de miles. Valor: ${original}`);
  const fraction = match[2] ?? '';
  const scale = unit === 'pesos' ? 2 : 0;
  if (/[^0]/.test(fraction.slice(scale))) {
    throw errorAt(context, unit === 'pesos'
      ? `el precio ${original} tiene fracciones menores a un centavo; no se redondeará.`
      : `el precio ${original} debe ser un número entero de centavos.`);
  }
  const digits = fraction.slice(0, scale).padEnd(scale, '0');
  const amount = BigInt(match[1]) * (unit === 'pesos' ? 100n : 1n) + BigInt(digits || '0');
  if (amount <= 0n || amount > MAX_SAFE) throw errorAt(context, 'el precio en centavos debe ser positivo y un entero seguro.');
  return Number(amount);
}

function identifier(value, field, context) {
  const original = text(required(value, field, context), field, context).trim();
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(original)) {
    throw errorAt(context, `${field} está en notación científica (${original}). Guárdalo como texto para conservar el identificador.`);
  }
  if (/[\r\n\t\u0000-\u001f]/.test(original)) throw errorAt(context, `${field} contiene caracteres de control.`);
  return original;
}

function dateText(value, field, context) {
  let original;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw errorAt(context, `${field} contiene una fecha inválida.`);
    if (value.getUTCMilliseconds() !== 0) throw errorAt(context, `${field} contiene milisegundos; usa precisión de segundos.`);
    original = `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')} ${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
  } else {
    original = text(required(value, field, context), field, context).trim().replace('T', ' ');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(original);
  if (!match) throw errorAt(context, `${field} requiere YYYY-MM-DD HH:mm:ss, sin zona horaria. Valor: ${original}`);
  const [, yy, mm, dd, hh, mi, ss] = match.map(Number);
  const leap = yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (yy < 1 || mm < 1 || mm > 12 || dd < 1 || dd > days[mm - 1] || hh > 23 || mi > 59 || ss > 59) {
    throw errorAt(context, `${field} contiene una fecha o una hora inválida: ${original}`);
  }
  return original;
}

function bindHeaders(headers, context, { positionalFallback = false } = {}) {
  const mapping = new Map();
  for (let index = 0; index < headers.length; index += 1) {
    if (isBlank(headers[index])) continue;
    const field = FIELD_BY_HEADER.get(normalizedHeader(headers[index]));
    if (!field) continue;
    if (mapping.has(field)) throw errorAt(context, `dos columnas corresponden a ${field}; deja una sola columna para ese dato.`);
    mapping.set(field, index);
  }
  const missing = COMMON_FIELDS.filter(field => !mapping.has(field));
  if (missing.length) {
    if (positionalFallback && HEADERLESS_SCHEMAS.has(headers.length)) return headerlessMapping(headers.length, context);
    throw errorAt(context, `faltan encabezados: ${missing.join(', ')}. Se aceptan los formatos Soriana y Benavides.`);
  }
  return mapping;
}

function recognizedHeaderCount(record) {
  return record.filter(value => FIELD_BY_HEADER.has(normalizedHeader(value))).length;
}

function headerlessMapping(width, context) {
  const fields = HEADERLESS_SCHEMAS.get(width);
  if (!fields) {
    throw errorAt(context, `el CSV contiene ${width} columnas; el formato estándar exige exactamente 14 en el orden Soriana/Benavides.`);
  }
  return new Map(fields.map((field, index) => [field, index]));
}

function scoreDelimiter(textValue, candidate, headerRow) {
  try {
    const preview = parse(textValue, {
      delimiter: candidate,
      bom: true,
      relax_column_count: true,
      to: headerRow + 9,
    });
    const records = preview.slice(headerRow - 1).filter(record => !record.every(isBlank));
    if (!records.length) return 0;
    const headerScore = recognizedHeaderCount(records[0]);
    if (headerScore >= 3) return 100 + headerScore;
    const width = records[0].length;
    if (!HEADERLESS_SCHEMAS.has(width)) return 0;
    const consistentRows = records.filter(record => record.length === width).length;
    return 50 + width + consistentRows / records.length;
  } catch {
    return 0;
  }
}

function parseCsv(textValue, delimiter, headerRow, fileName) {
  let selected = delimiter === '\\t' ? '\t' : delimiter;
  if (selected !== undefined && (typeof selected !== 'string' || selected.length !== 1 || /[\r\n"]/.test(selected))) {
    throw errorAt({ fileName }, 'delimiter debe ser un carácter, por ejemplo |, coma, punto y coma o tabulación.');
  }
  if (selected === undefined) {
    const scores = ['|', ',', ';', '\t']
      .map(candidate => ({ candidate, score: scoreDelimiter(textValue, candidate, headerRow) }))
      .sort((a, b) => b.score - a.score);
    if (scores[0].score === 0 || scores[0].score === scores[1].score) {
      throw errorAt({ fileName }, 'no se pudo detectar el separador. Indica delimiter de forma explícita.');
    }
    selected = scores[0].candidate;
  }
  let parsed;
  try {
    parsed = parse(textValue, { delimiter: selected, bom: true, relax_column_count: true, info: true });
  } catch (error) {
    throw errorAt({ fileName, row: error.lines }, `CSV inválido: ${error.message}`);
  }
  if (parsed.length < headerRow) throw errorAt({ fileName }, `no existe la fila inicial ${headerRow}.`);
  const firstRecord = parsed[headerRow - 1];
  const hasHeader = recognizedHeaderCount(firstRecord.record) >= 3;
  const expectedWidth = firstRecord.record.length;
  if (expectedWidth !== 14) {
    throw errorAt({ fileName, row: firstRecord.info.lines }, `el CSV contiene ${expectedWidth} columnas; el formato estándar exige exactamente 14 en el orden Soriana/Benavides.`);
  }
  const mapping = hasHeader
    ? bindHeaders(firstRecord.record, { fileName, row: firstRecord.info.lines }, { positionalFallback: true })
    : headerlessMapping(expectedWidth, { fileName, row: firstRecord.info.lines });
  const records = [];
  for (const { record, info } of parsed.slice(hasHeader ? headerRow : headerRow - 1)) {
    if (record.every(isBlank)) continue;
    if (record.length !== expectedWidth) {
      throw errorAt({ fileName, row: info.lines }, `se encontraron ${record.length} columnas; se esperaban ${expectedWidth}.`);
    }
    records.push({ values: Object.fromEntries([...mapping].map(([field, column]) => [field, record[column]])), row: info.lines });
  }
  return { records, delimiter: selected };
}

function excelValue(cell, field, context, address) {
  if (!cell) return '';
  if ('f' in cell || 'F' in cell) {
    throw errorAt(context, `la celda ${address} contiene una fórmula. Pega sus valores antes de importar; no se usan resultados almacenados.`);
  }
  if (cell.t === 'e') throw errorAt(context, `la celda ${address} contiene un error de Excel: ${cell.w ?? cell.v}.`);
  const value = cell.v;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (!DATE_FIELDS.has(field)) throw errorAt(context, `la celda ${address} contiene una fecha donde se esperaba ${field}.`);
    return value;
  }
  if (typeof value === 'object') {
    throw errorAt(context, `la celda ${address} contiene un tipo no admitido.`);
  }
  if (IDENTIFIERS.has(field) && typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || String(value).length > 15) {
      throw errorAt(context, `${field} en ${address} debe guardarse como texto: Excel no conserva identificadores numéricos de más de 15 dígitos.`);
    }
    const format = (cell.z ?? '').split(';')[0];
    return /^0+$/.test(format) ? String(value).padStart(format.length, '0') : String(value);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw errorAt(context, `la celda ${address} contiene un número fuera del rango seguro.`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw errorAt(context, `la celda ${address} no contiene texto ni un número.`);
  return value;
}

function nonBlankExcelCell(cell) {
  return cell && ('f' in cell || 'F' in cell || !isBlank(cell.v));
}

function rowsFromWorksheet(worksheet) {
  const rows = new Map();
  for (const [address, cell] of Object.entries(worksheet ?? {})) {
    if (!/^[A-Z]+[1-9]\d*$/.test(address) || !nonBlankExcelCell(cell)) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (!rows.has(r)) rows.set(r, new Map());
    rows.get(r).set(c, { address, cell });
  }
  return rows;
}

async function readExcel(filePath, { sheet, headerRow }, fileName) {
  let workbook;
  try {
    workbook = XLSX.read(await readFile(filePath), {
      type: 'buffer', cellNF: true, cellDates: true, cellFormula: true,
      cellText: false, raw: true, dense: false, nodim: true, UTC: true, WTF: true,
    });
  } catch (error) {
    throw errorAt({ fileName }, `no se pudo leer el archivo Excel: ${error.message}`);
  }
  const rowsBySheet = new Map(workbook.SheetNames.map(name => [name, rowsFromWorksheet(workbook.Sheets[name])]));
  const sheets = workbook.SheetNames.filter(name => rowsBySheet.get(name).has(headerRow - 1));
  let selected;
  if (sheet !== undefined && sheet !== '') {
    selected = workbook.SheetNames.find(name => name === String(sheet));
    if (!selected && /^\d+$/.test(String(sheet))) selected = workbook.SheetNames[Number(sheet) - 1];
    if (!selected) throw errorAt({ fileName }, `no existe la hoja ${sheet}. Disponibles: ${workbook.SheetNames.join(', ')}.`);
  } else if (sheets.length === 1) {
    selected = sheets[0];
  } else {
    throw errorAt({ fileName }, sheets.length === 0 ? 'no hay una hoja con encabezados.' : `hay varias hojas con datos; indica sheet. Disponibles: ${sheets.join(', ')}.`);
  }
  const sheetRows = rowsBySheet.get(selected);
  const header = sheetRows.get(headerRow - 1) ?? new Map();
  const width = header.size ? Math.max(...header.keys()) + 1 : 0;
  const headers = Array.from({ length: width }, (_, index) => {
    const entry = header.get(index);
    return excelValue(entry?.cell, 'encabezado', { fileName, row: headerRow }, entry?.address);
  });
  while (headers.length && isBlank(headers.at(-1))) headers.pop();
  const mapping = bindHeaders(headers, { fileName, row: headerRow });
  const records = [];
  for (const [rowIndex, cells] of [...sheetRows].sort(([a], [b]) => a - b)) {
    if (rowIndex < headerRow) continue;
    const rowNumber = rowIndex + 1;
    const context = { fileName, row: rowNumber };
    // Reject formulas in any populated source cell, including unrecognized columns.
    for (const [column, { address, cell }] of cells) {
      if ('f' in cell || 'F' in cell) {
        throw errorAt(context, `la celda ${address} contiene una fórmula. Pega sus valores antes de importar.`);
      }
      if (column >= headers.length) throw errorAt(context, `la celda ${address} tiene datos sin encabezado.`);
    }
    const values = Object.fromEntries([...mapping].map(([field, column]) => {
      const entry = cells.get(column);
      return [field, excelValue(entry?.cell, field, context, entry?.address)];
    }));
    if (Object.values(values).every(isBlank)) {
      throw errorAt(context, 'la fila contiene datos, pero ninguno corresponde a los campos de promociones.');
    }
    records.push({ values, row: rowNumber });
  }
  return { records, sheet: selected };
}

function buildPromotions(records, { moneyUnit }, fileName) {
  const groups = new Map();
  const overlapIndex = new Map();
  const warnings = [];
  const duplicateItemConflicts = [];
  const zeroDiscountItems = [];
  const unsupportedPercentageItems = [];
  for (const record of records) {
    const context = { fileName, row: record.row };
    const row = record.values;
    const sourceShopId = identifier(row.sourceShopId, 'shopid', context);
    const activityId = identifier(row.activityId, 'activityid', context);
    const sku = identifier(row.sku, 'sku / skuid', context);
    const activityType = integer(row.activityType, 'activity_type', context);
    const action = integer(row.action, 'activityaction', context, { allowZero: true });
    if (![2, 4, 8].includes(activityType)) throw errorAt(context, `activity_type ${activityType} no está soportado; se admiten 2, 4 y 8.`);
    if (action !== 1) throw errorAt(context, `activityaction ${action} no está soportado en esta versión; solo se admite 1. No se inferirá una cancelación.`);
    const name = text(required(row.activityName, 'activityname', context), 'activityname', context);
    const startDate = dateText(row.startDate, 'startdate', context);
    const endDate = dateText(row.endDate, 'enddate', context);
    if (startDate > endDate) throw errorAt(context, `la fecha inicial de la promoción ${activityId} es posterior a la final.`);
    const meta = { action, activity_type: activityType, activity_name: name, start_date: startDate, end_date: endDate };
    const item = { app_item_id: sku };
    let usedFields;
    if (activityType === 2) {
      item.discount_perc = integer(row.discountPercentage, 'discountpercentage / DiscPercentage', context, { allowZero: true });
      if (item.discount_perc > 100) throw errorAt(context, 'discountpercentage no puede superar 100.');
      usedFields = new Set(['discountPercentage']);
    } else if (activityType === 4) {
      item.buy_num = integer(row.buyNum, 'mxn_n / BuyNum', context);
      item.get_num = integer(row.getNum, 'mxn_m / GetNum', context);
      if (item.buy_num >= item.get_num) throw errorAt(context, 'buy_num debe ser menor que get_num (por ejemplo, 3x2: buy_num=2, get_num=3).');
      usedFields = new Set(['buyNum', 'getNum']);
    } else {
      item.bxgy_x = integer(row.bxgyX, 'BXGY_X', context);
      item.bxgy_y = money(row.bxgyY, moneyUnit, context);
      usedFields = new Set(['bxgyX', 'bxgyY']);
    }
    for (const field of NUMERIC_FIELDS) {
      if (!usedFields.has(field) && !isBlank(row[field]) && !isZeroPlaceholder(row[field])) {
        throw errorAt(context, `${field} contiene un valor incompatible o no soportado para activity_type ${activityType}.`);
      }
    }
    if (activityType === 2 && item.discount_perc === 0) {
      zeroDiscountItems.push({ sourceShopId, activityId, activityType, sku, row: record.row, activityName: name });
    }
    if (activityType === 2 && item.discount_perc !== 0 && (item.discount_perc < 5 || item.discount_perc > 99)) {
      unsupportedPercentageItems.push({
        sourceShopId, activityId, activityType, sku, row: record.row, activityName: name,
        discountPercentage: item.discount_perc,
      });
    }
    const key = JSON.stringify([sourceShopId, activityId]);
    let group = groups.get(key);
    if (!group) {
      const payload = { action, activity_type: activityType };
      if (activityType === 8) payload.child_type = 5;
      Object.assign(payload, { activity_id: activityId, activity_name: name, start_date: startDate, end_date: endDate, item_activity_list: [] });
      group = { sourceShopId, payload, sourceRows: [], seenSkus: new Map(), activityNames: new Set([name]) };
      groups.set(key, group);
    } else {
      const conflict = CONSISTENT_META_FIELDS.find(field => group.payload[field] !== meta[field]);
      if (conflict) throw errorAt(context, `la promoción ${activityId} de tienda ${sourceShopId} tiene valores incompatibles en ${conflict}; primera fila ${group.sourceRows[0]}.`);
      group.activityNames.add(name);
      if (group.activityNames.size > 1) group.payload.activity_name = `Promoción ${activityId}`;
    }
    group.sourceRows.push(record.row);
    const candidate = { row: record.row, activityName: name, item: { ...item } };
    const existing = group.seenSkus.get(sku);
    if (existing) {
      if (!existing.conflict) {
        existing.conflict = {
          id: `duplicate-${duplicateItemConflicts.length + 1}`,
          sourceShopId,
          activityId,
          activityType,
          sku,
          candidates: [existing.candidate],
        };
        duplicateItemConflicts.push(existing.conflict);
      }
      existing.conflict.candidates.push(candidate);
    } else {
      group.seenSkus.set(sku, { candidate, itemIndex: group.payload.item_activity_list.length, conflict: null });
      group.payload.item_activity_list.push(item);
    }
    const overlapKey = JSON.stringify([sourceShopId, sku]);
    if (!overlapIndex.has(overlapKey)) overlapIndex.set(overlapKey, { sourceShopId, activities: new Set() });
    overlapIndex.get(overlapKey).activities.add(activityId);
    if (activityType === 8 && item.bxgy_y === 1) {
      warnings.push({ code: 'ONE_CENT_PRICE', message: `La promoción ${activityId} asigna un centavo al SKU ${sku}; verifica si existe una condición entre productos que el archivo no expresa.`, sourceShopId, activityId, rows: [record.row] });
    }
  }
  const overlapping = new Map();
  for (const { sourceShopId, activities } of overlapIndex.values()) {
    if (activities.size > 1) overlapping.set(sourceShopId, (overlapping.get(sourceShopId) ?? 0) + 1);
  }
  for (const [sourceShopId, count] of overlapping) warnings.push({ code: 'OVERLAPPING_SKUS', sourceShopId, message: `${count} SKU aparecen en varias promociones de tienda ${sourceShopId}; se conservan todas las asociaciones. La prioridad entre promociones depende de la API.` });
  for (const group of groups.values()) {
    if (group.activityNames.size > 1) {
      warnings.push({
        code: 'ACTIVITY_NAME_NORMALIZED',
        sourceShopId: group.sourceShopId,
        activityId: group.payload.activity_id,
        rows: [...group.sourceRows],
        message: `${group.activityNames.size} nombres distintos compartían el Activity ID ${group.payload.activity_id}; se usó el nombre común "${group.payload.activity_name}".`,
      });
    }
  }
  const promotions = [...groups.values()].map(({ seenSkus, activityNames, ...group }) => group);
  const byType = {};
  const oneUnit = new Map();
  for (const group of promotions) {
    const type = String(group.payload.activity_type);
    byType[type] ??= { promotions: 0, items: 0 };
    byType[type].promotions += 1;
    byType[type].items += group.payload.item_activity_list.length;
    const count = group.payload.item_activity_list.filter(item => item.bxgy_x === 1).length;
    if (count) oneUnit.set(group.sourceShopId, (oneUnit.get(group.sourceShopId) ?? 0) + count);
  }
  for (const [sourceShopId, count] of oneUnit) warnings.push({ code: 'BXGY_QUANTITY_ONE', sourceShopId, message: `${count} registros de tienda ${sourceShopId} contienen BXGY_X=1; se conserva esa cantidad con el precio indicado.` });
  for (const conflict of duplicateItemConflicts) {
    warnings.push({
      code: 'DUPLICATE_SKU_REQUIRES_SELECTION',
      sourceShopId: conflict.sourceShopId,
      activityId: conflict.activityId,
      rows: conflict.candidates.map(candidate => candidate.row),
      message: `El UPC ${conflict.sku} se repite ${conflict.candidates.length} veces en la actividad ${conflict.activityId}; elige cuál conservar antes de generar la vista previa.`,
    });
  }
  if (zeroDiscountItems.length) {
    warnings.push({
      code: 'ZERO_DISCOUNT_REQUIRES_SELECTION',
      rows: zeroDiscountItems.map(item => item.row),
      message: `${zeroDiscountItems.length} filas contienen descuento de 0%; elige si se conservan o se omiten antes de generar la vista previa.`,
    });
  }
  if (unsupportedPercentageItems.length) {
    warnings.push({
      code: 'UNSUPPORTED_PERCENTAGE_REQUIRES_OMISSION',
      rows: unsupportedPercentageItems.map(item => item.row),
      message: `${unsupportedPercentageItems.length} filas contienen discount_perc fuera del rango entero de 5 a 99 aceptado por DiDi; deben omitirse antes de enviar.`,
    });
  }
  const itemCount = promotions.reduce((total, group) => total + group.payload.item_activity_list.length, 0);
  return { promotions, duplicateItemConflicts, zeroDiscountItems, unsupportedPercentageItems, warnings, stats: { rows: records.length, promotions: promotions.length, items: itemCount, byType, sourceShops: [...new Set(promotions.map(group => group.sourceShopId))] } };
}

/** Read CSV/XLSX/XLS without network access, preserving groups and original activity IDs. */
export async function loadPromotions(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new Error('Indica la ruta del archivo CSV, XLSX o XLS.');
  const extension = path.extname(filePath).toLowerCase();
  const fileName = options.fileName ? path.basename(String(options.fileName)) : path.basename(filePath);
  if (!['.csv', '.txt', '.tsv', '.xlsx', '.xls'].includes(extension)) throw errorAt({ fileName }, 'formato no soportado. Usa .csv, .txt, .tsv, .xlsx o .xls.');
  const headerRow = options.headerRow ?? 1;
  if (!Number.isSafeInteger(headerRow) || headerRow < 1) throw errorAt({ fileName }, 'headerRow debe ser un entero positivo.');
  const moneyUnit = options.moneyUnit ?? 'pesos';
  if (!['pesos', 'cents'].includes(moneyUnit)) throw errorAt({ fileName }, 'moneyUnit debe ser pesos o cents.');
  let input;
  let format;
  if (extension === '.xlsx' || extension === '.xls') {
    input = await readExcel(filePath, { sheet: options.sheet, headerRow }, fileName);
    format = extension.slice(1);
  } else {
    const encoding = options.encoding ?? 'utf-8';
    if (!['utf-8', 'windows-1252'].includes(encoding)) throw errorAt({ fileName }, 'encoding debe ser utf-8 o windows-1252.');
    let decoded;
    try {
      decoded = new TextDecoder(encoding, { fatal: true }).decode(await readFile(filePath));
    } catch (error) {
      if (error.code === 'ENOENT') throw errorAt({ fileName }, 'no se encontró el archivo.');
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw errorAt({ fileName }, `el archivo no usa ${encoding}; prueba windows-1252 si proviene de Excel para Windows.`);
      throw errorAt({ fileName }, `no se pudo leer el archivo: ${error.message}`);
    }
    input = parseCsv(decoded, options.delimiter, headerRow, fileName);
    format = 'csv';
  }
  if (!input.records.length) throw errorAt({ fileName }, 'el archivo no contiene promociones.');
  const result = buildPromotions(input.records, { moneyUnit }, fileName);
  return { ...result, meta: { fileName, format, ...(format === 'csv' ? { delimiter: input.delimiter } : { sheet: input.sheet }) } };
}

/** Batch promotions using both per-request limits, retaining source and item order. */
export function splitBatches(promotions, maxPromotions = 499, maxItems = 5999) {
  if (!Array.isArray(promotions)) throw new Error('promotions debe ser un arreglo.');
  for (const [name, value] of [['maxPromotions', maxPromotions], ['maxItems', maxItems]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} debe ser un entero positivo.`);
  }
  if (maxPromotions > 499) throw new Error('maxPromotions debe ser menor a 500.');
  if (maxItems > 5999) throw new Error('maxItems debe ser menor a 6000.');
  const batches = [];
  let current = [];
  let itemCount = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    itemCount = 0;
  };
  for (const promotion of promotions) {
    const items = promotion?.payload?.item_activity_list;
    if (!Array.isArray(items) || items.length === 0) throw new Error('Cada promoción debe contener item_activity_list con al menos un producto.');
    let offset = 0;
    while (offset < items.length) {
      if (current.length >= maxPromotions || itemCount >= maxItems) flush();
      const end = Math.min(offset + (maxItems - itemCount), items.length);
      const chunkItems = items.slice(offset, end);
      current.push(offset === 0 && end === items.length ? promotion : {
        ...promotion,
        payload: { ...promotion.payload, item_activity_list: chunkItems },
      });
      itemCount += chunkItems.length;
      offset = end;
      if (offset < items.length) flush();
    }
  }
  flush();
  return batches;
}
