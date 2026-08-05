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

export function looksLikeCityClub(fileName: string, lines: string[]) {
  const text = [fileName, ...lines.slice(0, 10)].join(' ').toLowerCase();
  return text.includes('city club') || text.includes('cityclub') || /(^|[^a-z])cck([^a-z]|$)/i.test(text);
}
