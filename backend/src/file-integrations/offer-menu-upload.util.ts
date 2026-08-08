import { FlatGroceryUpload } from './grocery-destination-menu.util';

export interface OfferMenuItem {
  sku: string;
  storeId: string;
  price: number;
  activityPrice: number;
}

export interface OfferMenuRequestConfig {
  categoryIdPrefix: string;
  categoryName: string;
  menuIdPrefix: string;
  menuNamePrefix: string;
  maxItemsPerCategory: number;
  activeStatus: number;
  includeTaxInfo: boolean;
  taxType: number;
  taxRate: number;
}

export interface ParsedOfferMenu {
  stores: Map<string, OfferMenuItem[]>;
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  duplicateItems: number;
  errors: string[];
}

export interface OfferMenuStreamStats {
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  errors: string[];
}

const REQUIRED_COLUMNS = ['SKU', 'STOREID', 'PRICE', 'FULL_PRICE'] as const;
export const OFFER_MENU_REQUEST_ITEM_LIMIT = 30_000;

function categoryId(value: string, index: number) {
  if (index === 0) return value;
  const match = value.match(/^(.*?)(\d+)$/);
  return match ? `${match[1]}${Number(match[2]) + index}` : `${value}_${index + 1}`;
}

export function buildOfferMenuRequest(
  config: OfferMenuRequestConfig,
  appShopId: string,
  items: OfferMenuItem[],
): FlatGroceryUpload {
  if (!items.length) throw new Error('Offer menu request requires at least one item');
  if (items.length > OFFER_MENU_REQUEST_ITEM_LIMIT) {
    throw new Error(`Offer menu request cannot exceed ${OFFER_MENU_REQUEST_ITEM_LIMIT} items`);
  }
  if (!Number.isInteger(config.maxItemsPerCategory) || config.maxItemsPerCategory < 1) {
    throw new Error('Offer menu category size must be a positive integer');
  }
  const categories: Array<{
    app_category_id: string;
    category_name: string;
    app_item_ids: string[];
  }> = [];
  for (let offset = 0; offset < items.length; offset += config.maxItemsPerCategory) {
    const current = items.slice(offset, offset + config.maxItemsPerCategory);
    const index = categories.length;
    categories.push({
      app_category_id: categoryId(config.categoryIdPrefix, index),
      category_name: index === 0 ? config.categoryName : `${config.categoryName} ${index + 1}`,
      app_item_ids: current.map(item => item.sku),
    });
  }
  const categoryIds = categories.map(category => category.app_category_id);
  return {
    menus: [{
      menu_name: `${config.menuNamePrefix}_${appShopId}`,
      app_menu_id: `${config.menuIdPrefix}_${appShopId}`,
      app_category_ids: categoryIds,
    }],
    categories,
    items: items.map(item => ({
      item_name: `Producto ${item.sku}`,
      upc: item.sku,
      app_item_id: item.sku,
      price: item.price,
      activity_price: item.activityPrice,
      status: config.activeStatus,
      ...(config.includeTaxInfo ? { tax_info_list: [{ type: config.taxType, rate: config.taxRate }] } : {}),
    })),
    categoryIds,
  };
}

export function toApiPrice(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const [integerPart, decimals = ''] = cleaned.split('.');
  const cents = decimals.padEnd(2, '0').slice(0, 2);
  const result = Number(`${integerPart}${cents}`);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export function parseDelimitedRows(content: string, delimiter: string): string[][] {
  if (!delimiter || delimiter.length !== 1) throw new Error('Offer CSV delimiter must be exactly one character');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = content.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(field.trim());
      field = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (quoted) throw new Error('Offer CSV contains an unterminated quoted value');
  row.push(field.trim());
  if (row.some(value => value.length > 0)) rows.push(row);
  return rows;
}

export function parseOfferMenuCsv(content: string, delimiter = ';'): ParsedOfferMenu {
  const rows = parseDelimitedRows(content, delimiter);
  if (rows.length < 2) throw new Error('Offer CSV has no data rows');
  const headers = rows[0].map(value => value.trim().toUpperCase());
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index])) as Record<string, number>;
  const missing = REQUIRED_COLUMNS.filter(column => indexes[column] === undefined);
  if (missing.length) throw new Error(`Offer CSV is missing required column(s): ${missing.join(', ')}`);

  const byStore = new Map<string, Map<string, OfferMenuItem>>();
  const errors: string[] = [];
  let rowsAccepted = 0;
  let rowsRejected = 0;
  let duplicateItems = 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const sku = String(row[indexes.SKU] ?? '').trim();
    const storeId = String(row[indexes.STOREID] ?? '').trim();
    const activityPrice = toApiPrice(row[indexes.PRICE]);
    const price = toApiPrice(row[indexes.FULL_PRICE]);
    if (!sku || !storeId || activityPrice === null || price === null) {
      rowsRejected += 1;
      if (errors.length < 50) {
        errors.push(`Row ${index + 1}: invalid ${!sku ? 'SKU' : !storeId ? 'STOREID' : activityPrice === null ? 'PRICE' : 'FULL_PRICE'}`);
      }
      continue;
    }
    const store = byStore.get(storeId) ?? new Map<string, OfferMenuItem>();
    if (store.has(sku)) duplicateItems += 1;
    store.set(sku, { sku, storeId, price, activityPrice });
    byStore.set(storeId, store);
    rowsAccepted += 1;
  }
  if (!byStore.size) throw new Error('Offer CSV contains no valid store/item rows');
  return {
    stores: new Map([...byStore].map(([storeId, items]) => [storeId, [...items.values()]])),
    rowsRead: rows.length - 1,
    rowsAccepted,
    rowsRejected,
    duplicateItems,
    errors,
  };
}

export async function streamOfferMenuCsv(
  chunks: AsyncIterable<string | Buffer>,
  delimiter: string,
  onItem: (item: OfferMenuItem) => void | Promise<void>,
): Promise<OfferMenuStreamStats> {
  if (!delimiter || delimiter.length !== 1) throw new Error('Offer CSV delimiter must be exactly one character');
  let headers: string[] | null = null;
  let indexes: Record<string, number> | null = null;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let skipLf = false;
  let rowsRead = 0;
  let rowsAccepted = 0;
  let rowsRejected = 0;
  const errors: string[] = [];

  const consume = async () => {
    const values = [...row, field.trim()];
    row = [];
    field = '';
    if (!values.some(value => value.length > 0)) return;
    if (!headers) {
      headers = values.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim().toUpperCase());
      indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
      const missing = REQUIRED_COLUMNS.filter(column => indexes?.[column] === undefined);
      if (missing.length) throw new Error(`Offer CSV is missing required column(s): ${missing.join(', ')}`);
      return;
    }
    rowsRead += 1;
    const sku = String(values[indexes!.SKU] ?? '').trim();
    const storeId = String(values[indexes!.STOREID] ?? '').trim();
    const activityPrice = toApiPrice(values[indexes!.PRICE]);
    const price = toApiPrice(values[indexes!.FULL_PRICE]);
    if (!sku || !storeId || activityPrice === null || price === null) {
      rowsRejected += 1;
      if (errors.length < 50) {
        errors.push(`Row ${rowsRead + 1}: invalid ${!sku ? 'SKU' : !storeId ? 'STOREID' : activityPrice === null ? 'PRICE' : 'FULL_PRICE'}`);
      }
      return;
    }
    await onItem({ sku, storeId, price, activityPrice });
    rowsAccepted += 1;
  };

  for await (const rawChunk of chunks) {
    const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      if (skipLf) {
        skipLf = false;
        if (char === '\n') continue;
      }
      if (char === '"') {
        if (quoted && chunk[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (!quoted && char === delimiter) {
        row.push(field.trim());
        field = '';
        continue;
      }
      if (!quoted && (char === '\n' || char === '\r')) {
        if (char === '\r') skipLf = true;
        await consume();
        continue;
      }
      field += char;
    }
  }
  if (quoted) throw new Error('Offer CSV contains an unterminated quoted value');
  if (field || row.length) await consume();
  if (!headers) throw new Error('Offer CSV is empty');
  if (!rowsAccepted) throw new Error('Offer CSV contains no valid store/item rows');
  return { rowsRead, rowsAccepted, rowsRejected, errors };
}

function zonedParts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find(value => value.type === type)?.value ?? 0);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

function zonedLocalToUtc(year: number, month: number, day: number, hour: number, timezone: string) {
  const desired = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, 0);
    candidate += desired - actualAsUtc;
  }
  return new Date(candidate);
}

export function nextOfferMenuRun(scheduleHours: number[], timezone: string, now = new Date()) {
  const hours = [...new Set(scheduleHours)].filter(value => Number.isInteger(value) && value >= 0 && value <= 23).sort((a, b) => a - b);
  if (!hours.length) throw new Error('At least one valid schedule hour is required');
  const current = zonedParts(now, timezone);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    for (const hour of hours) {
      const candidate = zonedLocalToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, timezone);
      if (candidate.getTime() > now.getTime() + 30_000) return candidate;
    }
  }
  throw new Error('Could not calculate the next offer menu execution');
}
