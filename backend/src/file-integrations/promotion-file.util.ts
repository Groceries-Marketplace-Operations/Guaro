export interface ParsedPromotionRow {
  shopExternalId: string;
  activityId: string;
  activityName: string | null;
  startDate: string | null;
  endDate: string | null;
  activityType: number | null;
  sku: string;
  discountAmount: string | null;
  discountPercentage: string | null;
  buyNum: string | null;
  getNum: string | null;
  bxgyX: string | null;
  bxgyY: string | null;
  actionType: number | null;
  rawData: Record<string, string | number | null>;
}

export function promotionShopIdFromFileName(fileName: string) {
  const match = /^promocionesdidi_(.+?)_\d{14}(?:_[^.]+)?\.(?:csv|txt)$/i.exec(fileName.trim());
  return match?.[1]?.trim() || null;
}

export function isPromotionHeader(columns: string[]) {
  const first = normalizeHeader(columns[0] ?? '');
  const second = normalizeHeader(columns[1] ?? '');
  return first === 'shopid' && second === 'activityid';
}

export function parsePromotionLines(lines: string[], delimiter: string) {
  const rows: ParsedPromotionRow[] = [];
  let invalidRows = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const columns = line.split(delimiter).map(value => value.trim());
    if (index === 0 && isPromotionHeader(columns)) continue;
    if (columns.length < 14 || !columns[0] || !columns[1] || !columns[6]) {
      invalidRows++;
      continue;
    }
    const row: ParsedPromotionRow = {
      shopExternalId: columns[0],
      activityId: columns[1],
      activityName: nullable(columns[2]),
      startDate: nullable(columns[3]),
      endDate: nullable(columns[4]),
      activityType: integer(columns[5]),
      sku: columns[6],
      discountAmount: nullable(columns[7]),
      discountPercentage: nullable(columns[8]),
      buyNum: nullable(columns[9]),
      getNum: nullable(columns[10]),
      bxgyX: nullable(columns[11]),
      bxgyY: nullable(columns[12]),
      actionType: integer(columns[13]),
      rawData: {},
    };
    row.rawData = {
      shopId: row.shopExternalId,
      activityId: row.activityId,
      activityName: row.activityName,
      startDate: row.startDate,
      endDate: row.endDate,
      activityType: row.activityType,
      sku: row.sku,
      discountAmount: row.discountAmount,
      discountPercentage: row.discountPercentage,
      buyNum: row.buyNum,
      getNum: row.getNum,
      bxgyX: row.bxgyX,
      bxgyY: row.bxgyY,
      actionType: row.actionType,
    };
    rows.push(row);
  }
  return { rows, invalidRows };
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nullable(value: string) {
  return value === '' ? null : value;
}

function integer(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
