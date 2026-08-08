export const DAILY_STATUS_ACTIVATION_TIME = '08:15';
export const DAILY_STATUS_ACTIVATION_TIMEZONE = 'Etc/GMT+6';

export function validateDailyTime(value: string) {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error('Daily time must use HH:MM in 24-hour format');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function zonedParts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find(value => value.type === type)?.value ?? 0);
  return {
    year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'), second: part('second'),
  };
}

function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second, 0,
    );
    candidate += desired - actualAsUtc;
  }
  return new Date(candidate);
}

export function nextDailyFileIntegrationRun(
  dailyTime: string,
  timezone: string,
  now = new Date(),
) {
  const { hour, minute } = validateDailyTime(dailyTime);
  // Throws RangeError for an invalid IANA timezone.
  const current = zonedParts(now, timezone);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    const candidate = zonedLocalToUtc(
      date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      hour, minute, timezone,
    );
    if (candidate.getTime() > now.getTime() + 30_000) return candidate;
  }
  throw new Error('Could not calculate the next daily file integration execution');
}

export function localDateKey(now: Date, timezone: string) {
  const current = zonedParts(now, timezone);
  return `${current.year}${String(current.month).padStart(2, '0')}${String(current.day).padStart(2, '0')}`;
}

export function lastTimestampDate(fileName: string) {
  const matches = [...fileName.matchAll(/\d{14}/g)];
  return matches.length ? matches[matches.length - 1][0].slice(0, 8) : null;
}

export function transformDailyStatusCsv(value: Buffer | string) {
  const input = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  const totalLines = input.length === 0
    ? 0
    : input.split(/\r\n|\n|\r/).length - (/\r\n$|\n$|\r$/.test(input) ? 1 : 0);
  const changedLines = input.match(/\|M(?=\r?$)/gm)?.length ?? 0;
  const alreadyActiveLines = input.match(/\|A(?=\r?$)/gm)?.length ?? 0;
  const output = input.replace(/\|M(?=\r?$)/gm, '|A');
  return {
    output: Buffer.from(output, 'utf8'),
    totalLines,
    changedLines,
    alreadyActiveLines,
  };
}
