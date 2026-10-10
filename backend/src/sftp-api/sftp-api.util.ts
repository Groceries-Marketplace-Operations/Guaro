import { runInNewContext } from 'node:vm';
import { parseDelimitedRows } from '../file-integrations/offer-menu-upload.util';

export const MX_ZONE = 'America/Mexico_City';
export type Mode = 'full' | 'delta';
export type Schedule = { time: string; mode: Mode };
export const MAPPING_FIELDS = ['app_shop_id', 'app_item_id', 'upc', 'item_name', 'price', 'activity_price', 'stock', 'status'] as const;
export interface ParseConfig {
  delimiter: string; hasHeader: boolean; shopSource: string; shopRegex: string; mapping: Record<string, string>;
}
export type Item = { app_item_id: string; stock: number; upc?: string; item_name?: string; price?: number; activity_price?: number; status?: number };

export function mxDate(date: Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: MX_ZONE, dateStyle: 'short', timeStyle: 'medium' }).format(date) + ' America/Mexico_City';
}

export function nextSchedule(schedules: Schedule[], after = new Date()) {
  // Iterate absolute minutes so the result never depends on the host timezone.
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: MX_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let minute = Math.floor(after.getTime() / 60_000) + 1, end = minute + 2880; minute < end; minute++) {
    const date = new Date(minute * 60_000);
    const schedule = schedules.find(value => value.time === formatter.format(date));
    if (schedule) return { at: date, mode: schedule.mode };
  }
  throw new Error('No hay horarios válidos');
}

export function regexMatches(pattern: string, names: string[]): (string[] | null)[] {
  // Patterns are intentionally configurable, not literal search strings. Keep both
  // compilation and matching within the time budget; never interpolate into code.
  if (typeof pattern !== 'string' || pattern.length > 500) throw new Error('El regex debe ser un texto de hasta 500 caracteres');
  return runInNewContext('const regex = new RegExp(pattern); names.map(name => { const m = name.match(regex); return m ? Array.from(m) : null; })',
    { names, pattern }, { timeout: 1000 }) as (string[] | null)[];
}

export function columnIndex(column: string) {
  if (!/^[A-Z]{1,3}$/.test(column)) throw new Error(`Columna inválida: ${column}. Usa A, B, C…`);
  return [...column].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

export function minorUnits(raw: string) {
  const match = raw.match(/^\+?(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('El precio debe ser un número positivo con punto decimal');
  const fraction = match[2] ?? '';
  const value = BigInt(match[1]) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)) + (fraction[2] >= '5' ? 1n : 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Precio fuera de rango');
  return Number(value);
}

export function parseFile(content: string, fileName: string, config: ParseConfig, mode: Mode, reports: string[] = []) {
  const rows = parseDelimitedRows(content, config.delimiter);
  if (config.hasHeader) rows.shift();
  if (!rows.length) throw new Error('El archivo no contiene productos');
  const fileShop = config.shopSource === 'filename' ? regexMatches(config.shopRegex, [fileName])[0]?.[1] : undefined;
  if (config.shopSource === 'filename' && !fileShop) throw new Error('El regex de tienda debe capturar el app_shop_id en su primer grupo');
  const stores = new Map<string, Map<string, Item>>();
  const selections = new Map<string, { price?: number; row: number }>();
  const discarded = new Map<string, number>();
  rows.forEach((row, index) => {
    try {
      // Some exporters wrap the entire delimited record in one CSV field.
      // Only unwrap single-field records; normal quoted fields remain intact.
      if (row.length === 1 && row[0].includes(config.delimiter)) {
        const inner = parseDelimitedRows(row[0], config.delimiter);
        if (inner.length === 1 && inner[0].length > 1) row = inner[0];
      }
      const field = (name: string) => config.mapping[name] ? (row[columnIndex(config.mapping[name])] ?? '').trim() : '';
      const shop = config.shopSource === 'filename' ? fileShop! : field('app_shop_id');
      const id = field('app_item_id');
      if (!shop || !id || shop.length > 100 || id.length > 100) throw new Error('Falta app_shop_id o app_item_id válido');
      if (!stores.has(shop)) stores.set(shop, new Map());
      const items = stores.get(shop)!;
      if (!items.has(id) && items.size >= 30_000) {
        discarded.set(shop, (discarded.get(shop) ?? 0) + 1);
        return;
      }
      const rawStock = field('stock');
      if (!/^\+?\d+(?:\.\d+)?$/.test(rawStock)) throw new Error('Stock inválido');
      const stock = Math.floor(Number(rawStock));
      if (!Number.isSafeInteger(stock)) throw new Error('Stock fuera de rango');
      const item: Item = { app_item_id: id, stock };
      if (mode === 'full') {
        const upc = field('upc');
        if (!upc) throw new Error('UPC obligatorio');
        const name = field('item_name');
        if (!name || name.length > 50) throw new Error('item_name debe tener entre 1 y 50 caracteres');
        const price = minorUnits(field('price'));
        if (!price) throw new Error('El precio debe ser mayor a cero');
        const status = config.mapping.status ? Number(field('status')) : (stock > 0 ? 1 : 2);
        if (![1, 2].includes(status)) throw new Error('status debe ser 1 o 2');
        Object.assign(item, { upc, item_name: name, price, status });
        if (config.mapping.activity_price) {
          const promo = minorUnits(field('activity_price'));
          if (promo > 0 && promo < price && (price - promo) * 100 >= price) item.activity_price = promo;
        }
      }
      let comparisonPrice: number | undefined;
      if (mode === 'full') comparisonPrice = item.activity_price ?? item.price;
      else {
        // Prices select the duplicate's stock; Delta never sends these prices.
        try {
          const regular = minorUnits(field('price'));
          if (regular > 0) {
            comparisonPrice = regular;
            if (config.mapping.activity_price && field('activity_price')) {
              const promo = minorUnits(field('activity_price'));
              if (promo > 0 && promo < regular && (regular - promo) * 100 >= regular) comparisonPrice = promo;
            }
          }
        } catch { /* Invalid optional prices do not invalidate stock updates. */ }
      }
      const selectionKey = JSON.stringify([shop, id]);
      const previous = selections.get(selectionKey);
      const rowNumber = index + (config.hasHeader ? 2 : 1);
      if (previous) {
        const comparable = comparisonPrice !== undefined && previous.price !== undefined;
        const replace = comparable && comparisonPrice! < previous.price!;
        reports.push(`Duplicado ${id}, tienda ${shop}: filas ${previous.row} y ${rowNumber}. Se conserva fila ${replace ? rowNumber : previous.row} (${comparable ? 'precio menor o igual' : 'sin precios comparables; se conserva la primera'}).`);
        if (!replace) return;
      }
      items.set(id, item);
      selections.set(selectionKey, { price: comparisonPrice, row: rowNumber });
    } catch (error) { throw new Error(`Fila ${index + (config.hasHeader ? 2 : 1)}: ${(error as Error).message}`); }
  });
  for (const [shop, count] of discarded) reports.push(`Tienda ${shop}: ${count} filas descartadas por el límite de 30,000 productos únicos. Se conservan los primeros 30,000 IDs; sus duplicados se comparan por precio.`);
  return stores;
}

export function groceryPayload(shop: string, items: Item[]) {
  const categories = [];
  for (let offset = 0; offset < items.length; offset += 3000) {
    categories.push({ app_category_id: `despensa_${shop}_${String(categories.length + 1).padStart(2, '0')}`,
      category_name: 'Despensa', app_item_ids: items.slice(offset, offset + 3000).map(item => item.app_item_id), sub_category_ids: [] });
  }
  return { menus: [{ app_menu_id: `grocery_${shop}`, menu_name: `Grocery ${shop}`, app_category_ids: categories.map(c => c.app_category_id) }],
    categories, items, merge_policy: 1 };
}

export function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) =>
    [key, /token|secret|password|signature/i.test(key) ? '<redacted>' : redact(val)]));
  return value;
}
