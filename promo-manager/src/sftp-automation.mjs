import path from 'node:path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

const STANDARD_WIDTH = 14;
const START_COLUMN = 3;
const END_COLUMN = 4;
const SUPPORTED_TYPES = new Set([2, 4, 8]);
const TYPE_NAMES = {
  2: 'Descuento porcentual',
  4: 'Compra N, recibe M',
  8: 'Cantidad a precio fijo',
};

const normalizedHeader = value => String(value ?? '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/[\s_]+/g, '');

const recognizedHeaders = new Set([
  'shopid', 'storeid', 'activityid', 'activityname', 'startdate', 'enddate',
  'activitytype', 'activitttype', 'skuid', 'sku', 'discountamount',
  'discountpercentage', 'discpercentage', 'buynum', 'getnum', 'mxnn', 'mxnm',
  'bxgyx', 'bxgyy', 'finaldiscountedprice', 'activityaction',
]);

function requiredWallClock(value, label) {
  const text = String(value ?? '').trim().replace('T', ' ');
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label} requiere YYYY-MM-DD HH:mm:ss.`);
  const [, yy, mm, dd, hh, mi, ss] = match.map(Number);
  const leap = yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (yy < 1 || mm < 1 || mm > 12 || dd < 1 || dd > days[mm - 1] || hh > 23 || mi > 59 || ss > 59) {
    throw new Error(`${label} contiene una fecha u hora inválida: ${text}.`);
  }
  return text;
}

function csvDelimiter(text) {
  const candidates = ['|', ',', ';', '\t'].map(delimiter => {
    try {
      const rows = parse(text, { delimiter, bom: true, relax_column_count: true, to: 8 });
      const populated = rows.filter(row => !row.every(value => String(value ?? '').trim() === ''));
      const widthMatches = populated.filter(row => row.length === STANDARD_WIDTH).length;
      const headerMatches = populated[0]?.filter(value => recognizedHeaders.has(normalizedHeader(value))).length ?? 0;
      return { delimiter, score: widthMatches * 10 + headerMatches };
    } catch {
      return { delimiter, score: 0 };
    }
  }).sort((left, right) => right.score - left.score);
  if (!candidates[0].score || candidates[0].score === candidates[1].score) {
    throw new Error('No se pudo detectar de forma segura el separador del archivo.');
  }
  return candidates[0].delimiter;
}

function csvField(value, delimiter) {
  const text = String(value ?? '');
  return /["\r\n]/.test(text) || text.includes(delimiter)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function rewriteCsv(buffer, fileName, dates, encoding) {
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${fileName}: no se pudo leer usando ${encoding}.`);
  }
  const delimiter = csvDelimiter(text);
  const rows = parse(text, { delimiter, bom: true, relax_column_count: true });
  const first = rows.find(row => !row.every(value => String(value ?? '').trim() === ''));
  if (!first || first.length !== STANDARD_WIDTH) {
    throw new Error(`${fileName}: el formato estándar requiere exactamente 14 columnas.`);
  }
  const firstIndex = rows.indexOf(first);
  const hasHeader = first.filter(value => recognizedHeaders.has(normalizedHeader(value))).length >= 3;
  let changedRows = 0;
  for (let index = hasHeader ? firstIndex + 1 : firstIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every(value => String(value ?? '').trim() === '')) continue;
    if (row.length !== STANDARD_WIDTH) throw new Error(`${fileName}, fila ${index + 1}: se esperaban 14 columnas.`);
    if (dates.startDate) row[START_COLUMN] = dates.startDate;
    if (dates.endDate) row[END_COLUMN] = dates.endDate;
    const start = String(row[START_COLUMN] ?? '').trim().replace('T', ' ');
    const end = String(row[END_COLUMN] ?? '').trim().replace('T', ' ');
    if (start > end) throw new Error(`${fileName}, fila ${index + 1}: la fecha inicial quedaría después de la final.`);
    changedRows += 1;
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const output = `${bom}${rows.map(row => row.map(value => csvField(value, delimiter)).join(delimiter)).join(newline)}${newline}`;
  return { buffer: Buffer.from(output, 'utf8'), changedRows, format: 'csv', encoding: 'utf-8' };
}

function rewriteExcel(buffer, fileName, dates, extension) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true, UTC: true });
  } catch (error) {
    throw new Error(`${fileName}: no se pudo abrir Excel: ${error.message}`);
  }
  const populatedSheets = workbook.SheetNames.filter(name => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, blankrows: false });
    return rows.length > 0;
  });
  if (populatedSheets.length !== 1) throw new Error(`${fileName}: debe contener una sola hoja con datos para editarla automáticamente.`);
  const sheet = workbook.Sheets[populatedSheets[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
  const first = rows[0] ?? [];
  if (first.length !== STANDARD_WIDTH) throw new Error(`${fileName}: el formato estándar requiere exactamente 14 columnas.`);
  const hasHeader = first.filter(value => recognizedHeaders.has(normalizedHeader(value))).length >= 3;
  let changedRows = 0;
  for (let rowIndex = hasHeader ? 1 : 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.length || row.every(value => String(value ?? '').trim() === '')) continue;
    if (dates.startDate) sheet[XLSX.utils.encode_cell({ r: rowIndex, c: START_COLUMN })] = { t: 's', v: dates.startDate };
    if (dates.endDate) sheet[XLSX.utils.encode_cell({ r: rowIndex, c: END_COLUMN })] = { t: 's', v: dates.endDate };
    const start = String(dates.startDate ?? row[START_COLUMN] ?? '').trim().replace('T', ' ');
    const end = String(dates.endDate ?? row[END_COLUMN] ?? '').trim().replace('T', ' ');
    if (start > end) throw new Error(`${fileName}, fila ${rowIndex + 1}: la fecha inicial quedaría después de la final.`);
    changedRows += 1;
  }
  const bookType = extension === '.xls' ? 'biff8' : 'xlsx';
  return { buffer: XLSX.write(workbook, { type: 'buffer', bookType }), changedRows, format: bookType, encoding: null };
}

export function normalizeAutomationDates(input = {}) {
  const startDate = requiredWallClock(input.startDate, 'La fecha inicial');
  const endDate = requiredWallClock(input.endDate, 'La fecha final');
  if (startDate && endDate && startDate > endDate) throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
  return { startDate, endDate };
}

export function rewritePromotionDates(buffer, fileName, input = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error(`${fileName}: el archivo está vacío.`);
  const dates = normalizeAutomationDates(input);
  if (!dates.startDate && !dates.endDate) return { buffer, changedRows: 0, format: null, encoding: input.encoding ?? 'utf-8', dates };
  const extension = path.extname(String(fileName)).toLowerCase();
  const rewritten = ['.xlsx', '.xls'].includes(extension)
    ? rewriteExcel(buffer, fileName, dates, extension)
    : rewriteCsv(buffer, fileName, dates, input.encoding ?? 'utf-8');
  return { ...rewritten, dates };
}

function selectedTypes(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Selecciona al menos un tipo de promoción.');
  const types = [...new Set(value.map(Number))];
  if (types.some(type => !SUPPORTED_TYPES.has(type))) throw new Error('Solo se admiten los tipos de promoción 2, 4 y 8.');
  return types;
}

function itemSignature(candidate) {
  return JSON.stringify(candidate?.item ?? null);
}

export function prepareDatasetForAutomation(dataset, inputTypes) {
  const types = selectedTypes(inputTypes);
  const typeSet = new Set(types);
  const selected = structuredClone(dataset);
  selected.promotions = selected.promotions.filter(promotion => typeSet.has(Number(promotion.payload.activity_type)));
  if (!selected.promotions.length) return {
    dataset: selected,
    rules: { duplicateRowsCollapsed: 0, zeroPercentItemsOmitted: 0, unsupportedPercentItemsOmitted: 0 },
    types,
  };
  const selectedKeys = new Set(selected.promotions.map(promotion => `${promotion.sourceShopId}\0${promotion.payload.activity_id}`));
  let duplicateRowsCollapsed = 0;
  for (const conflict of dataset.duplicateItemConflicts ?? []) {
    if (!selectedKeys.has(`${conflict.sourceShopId}\0${conflict.activityId}`)) continue;
    const signatures = new Set(conflict.candidates.map(itemSignature));
    if (signatures.size > 1) {
      throw new Error(`El UPC ${conflict.sku} tiene mecánicas diferentes en la actividad ${conflict.activityId}; requiere elegir una fila manualmente.`);
    }
    duplicateRowsCollapsed += Math.max(0, conflict.candidates.length - 1);
  }
  let zeroPercentItemsOmitted = 0;
  let unsupportedPercentItemsOmitted = 0;
  for (const promotion of selected.promotions) {
    if (Number(promotion.payload.activity_type) !== 2) continue;
    promotion.payload.item_activity_list = promotion.payload.item_activity_list.filter(item => {
      const percentage = item.discount_perc;
      if (percentage === 0) {
        zeroPercentItemsOmitted += 1;
        return false;
      }
      if (!Number.isInteger(percentage) || percentage < 5 || percentage > 99) {
        unsupportedPercentItemsOmitted += 1;
        return false;
      }
      return true;
    });
    if (!promotion.payload.item_activity_list.length) {
      throw new Error(`La actividad ${promotion.payload.activity_id} quedaría sin productos después de aplicar el rango de 5% a 99%.`);
    }
  }
  selected.stats = {
    ...selected.stats,
    promotions: selected.promotions.length,
    items: selected.promotions.reduce((total, promotion) => total + promotion.payload.item_activity_list.length, 0),
    sourceShops: [...new Set(selected.promotions.map(promotion => promotion.sourceShopId))],
  };
  selected.duplicateItemConflicts = [];
  selected.zeroDiscountItems = [];
  selected.unsupportedPercentageItems = [];
  return {
    dataset: selected,
    rules: { duplicateRowsCollapsed, zeroPercentItemsOmitted, unsupportedPercentItemsOmitted },
    types,
  };
}

export function automationTypeSummary(dataset) {
  const summary = new Map();
  for (const promotion of dataset.promotions ?? []) {
    const type = Number(promotion.payload.activity_type);
    const current = summary.get(type) ?? { type, name: TYPE_NAMES[type] ?? `Tipo ${type}`, promotions: 0, items: 0 };
    current.promotions += 1;
    current.items += promotion.payload.item_activity_list?.length ?? 0;
    summary.set(type, current);
  }
  return [...summary.values()].sort((left, right) => left.type - right.type);
}

export function promotionTypeName(type) {
  return TYPE_NAMES[Number(type)] ?? `Tipo ${type}`;
}
