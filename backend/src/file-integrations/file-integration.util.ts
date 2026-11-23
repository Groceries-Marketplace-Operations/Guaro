import { localDateKey } from './daily-status-activation.util';

export function priceFilterTimeZone(country?: string | null) {
  return country === 'CO' ? 'America/Bogota' : 'America/Mexico_City';
}

export function filesModifiedToday<T extends { modifyTime: number }>(files: T[], now: Date, timezone: string): T[] {
  const today = localDateKey(now, timezone);
  return files.filter(file => {
    if (!Number.isFinite(file.modifyTime)) return false;
    try { return localDateKey(new Date(file.modifyTime), timezone) === today; }
    catch { return false; }
  });
}

export function sorianaShopIdFromFileName(fileName: string): string | null {
  const match = /^preciosdidi_suc_(\d+)_/i.exec(fileName);
  return match ? match[1].replace(/^0+(?=\d)/, '') : null;
}

export function cityClubFileMatches(fileName: string, cityClubShopIds: Set<string>) {
  const shopId = sorianaShopIdFromFileName(fileName);
  return shopId ? cityClubShopIds.has(shopId) : looksLikeCityClub(fileName, []);
}

export function wildcardToRegExp(pattern: string) {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped || '.*'}$`, 'i');
}

export function detectDelimiter(line: string, configured?: string | null) {
  if (configured) return configured === '\\t' ? '\t' : configured;
  const candidates = ['|', ';', ',', '\t'];
  return candidates
    .map(value => ({ value, count: line.split(value).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.value || ',';
}

export function parseAmount(value: string) {
  const cleaned = value.trim().replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') && !cleaned.includes('.')
    ? cleaned.replace(',', '.')
    : cleaned.replace(/,/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function normalizeUpc(value: string) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '').trim();
  return /^\d+[.]0+$/.test(trimmed) ? trimmed.replace(/[.]0+$/, '') : trimmed;
}

export const SFTP_FILTER_MAX_CODES = 100_000;
export const SFTP_FILTER_MODES = ['amount', 'code', 'amount_and_code'] as const;
export type SftpFilterMode = typeof SFTP_FILTER_MODES[number];

export function parseSftpFilterMode(value: string): SftpFilterMode {
  if (SFTP_FILTER_MODES.some(mode => mode === value)) return value as SftpFilterMode;
  throw new Error(`Unsupported SFTP filter mode: ${value}`);
}

export function filterSftpRows(
  lines: string[],
  delimiter: string,
  options: {
    filterMode: string;
    thresholdAmount: number | null;
    priceColumn: number | null;
    upcColumn: number | null;
    excludedUpcs: string[] | ReadonlySet<string>;
  },
) {
  const mode = parseSftpFilterMode(options.filterMode);
  const byAmount = mode === 'amount' || mode === 'amount_and_code';
  const byCode = mode === 'code' || mode === 'amount_and_code';
  if (byAmount && (options.priceColumn === null || options.thresholdAmount === null)) {
    throw new Error('Amount filter is missing its column or threshold');
  }
  const excluded = Array.isArray(options.excludedUpcs)
    ? new Set(options.excludedUpcs.map(normalizeUpc).filter(Boolean))
    : options.excludedUpcs as ReadonlySet<string>;
  if (byCode && (options.upcColumn === null || excluded.size === 0)) {
    throw new Error('Code filter is missing its column or codes');
  }
  const kept: string[] = [];
  let rowsRead = 0;
  let rowsKept = 0;
  let rowsRemoved = 0;
  let rowsRemovedByAmount = 0;
  let rowsRemovedByUpc = 0;
  let invalidAmounts = 0;
  for (const line of lines) {
    if (!line.trim()) { kept.push(line); continue; }
    rowsRead += 1;
    const columns = line.split(delimiter);
    const code = byCode && options.upcColumn !== null
      ? normalizeUpc(columns[options.upcColumn] ?? '')
      : '';
    if (code && excluded.has(code)) {
      rowsRemoved += 1;
      rowsRemovedByUpc += 1;
      continue;
    }
    if (byAmount && options.priceColumn !== null && options.thresholdAmount !== null) {
      const amount = parseAmount(columns[options.priceColumn] ?? '');
      if (amount === null) {
        invalidAmounts += 1;
      } else if (amount > options.thresholdAmount) {
        rowsRemoved += 1;
        rowsRemovedByAmount += 1;
        continue;
      }
    }
    rowsKept += 1;
    kept.push(line);
  }
  return { kept, rowsRead, rowsKept, rowsRemoved, rowsRemovedByAmount, rowsRemovedByUpc, invalidAmounts };
}

export function looksLikeCityClub(fileName: string, lines: string[]) {
  const text = [fileName, ...lines.slice(0, 10)].join(' ').toLowerCase();
  return text.includes('city club') || text.includes('cityclub') || /(^|[^a-z])cck([^a-z]|$)/i.test(text);
}
