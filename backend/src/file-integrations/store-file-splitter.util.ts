export interface StoreFileCandidate {
  name: string;
  modifyTime: number;
}

export interface StoreFileOutput {
  shopId: string;
  fileName: string;
  content: string;
  count: number;
}

export function extractStoreFileDate(fileName: string) {
  return fileName.match(/_(\d{8})_/)?.[1] ?? null;
}

export function pickStoreFileCandidate<T extends StoreFileCandidate>(files: T[], strategy = 'mtime') {
  if (files.length === 0) return null;
  const values = [...files];
  if (strategy.toLowerCase() === 'namedate') {
    return values.sort((left, right) => {
      const leftDate = Number(extractStoreFileDate(left.name) ?? 0);
      const rightDate = Number(extractStoreFileDate(right.name) ?? 0);
      return rightDate - leftDate || right.modifyTime - left.modifyTime || right.name.localeCompare(left.name);
    })[0];
  }
  return values.sort((left, right) => right.modifyTime - left.modifyTime || right.name.localeCompare(left.name))[0];
}

function isNumeric(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.includes(',')) return false;
  return Number.isFinite(Number(normalized));
}

export function splitStoreFile(csvText: string, date: string) {
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) throw new Error('The remote file is empty');

  const rowsByShop = new Map<string, string[]>();
  let malformed = 0;
  for (const raw of lines) {
    const parts = raw.trim().split('|').map(value => value.trim());
    const shopId = parts[0];
    if (!shopId || !/^[A-Za-z0-9_-]+$/.test(shopId)) {
      malformed++;
      continue;
    }
    const lastIndex = parts.length - 1;
    if (isNumeric(parts[lastIndex])) parts[lastIndex] = String(Math.trunc(Number(parts[lastIndex])));
    const shopRows = rowsByShop.get(shopId) ?? [];
    shopRows.push(parts.join('|'));
    rowsByShop.set(shopId, shopRows);
  }

  const outputs: StoreFileOutput[] = [...rowsByShop.entries()].map(([shopId, rows]) => ({
    shopId,
    fileName: `preciosdidi_suc_${shopId}_${date}_1.csv`,
    content: rows.join('\n'),
    count: rows.length,
  }));
  if (outputs.length === 0) throw new Error('The remote file has no valid shop rows');
  return { outputs, malformed, totalLines: lines.length };
}
