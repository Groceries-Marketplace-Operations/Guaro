const COUNTRY_TIMEZONES: Record<string, string> = {
  MX: 'America/Mexico_City',
  CO: 'America/Bogota',
  CR: 'America/Costa_Rica',
};

export function timezoneForCountry(country: string) {
  return COUNTRY_TIMEZONES[country] ?? 'UTC';
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

function fromZonedParts(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const displayed = zonedParts(utcGuess, timezone);
  const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, displayed.hour, displayed.minute, displayed.second);
  const offset = displayedAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offset);
}

export function nextDailyRun(after: Date, hour: number, minute: number, timezone: string) {
  const local = zonedParts(after, timezone);
  let candidate = fromZonedParts(local.year, local.month, local.day, hour, minute, timezone);
  if (candidate <= after) {
    const nextLocalDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    candidate = fromZonedParts(
      nextLocalDay.getUTCFullYear(),
      nextLocalDay.getUTCMonth() + 1,
      nextLocalDay.getUTCDate(),
      hour,
      minute,
      timezone,
    );
  }
  return candidate;
}

export function nextDailyRunFromTimes(after: Date, executionTimes: string[], timezone: string) {
  if (executionTimes.length === 0) throw new Error('At least one daily execution time is required');
  return executionTimes
    .map(value => {
      const [hour, minute] = value.split(':').map(Number);
      return nextDailyRun(after, hour, minute, timezone);
    })
    .sort((left, right) => left.getTime() - right.getTime())[0];
}
