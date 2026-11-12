export interface TaskWorkSchedule {
  workDays: number[]; // ISO weekday: Monday 1, Sunday 7
  workStartMinute: number;
  workEndMinute: number;
  workTimeZone: string;
}

type LocalDay = { year: number; month: number; day: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

function nextDay(day: LocalDay): LocalDay {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoWeekday(day: LocalDay) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() || 7;
}

function localMinuteToUtc(day: LocalDay, minute: number, timeZone: string) {
  const target = Date.UTC(day.year, day.month - 1, day.day, Math.floor(minute / 60), minute % 60);
  let guess = target;
  for (let attempt = 0; attempt < 6; attempt++) {
    const actual = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second);
    const delta = target - represented;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  throw new RangeError('The configured work time does not exist in this time zone');
}

function windowFor(day: LocalDay, schedule: TaskWorkSchedule) {
  if (!schedule.workDays.includes(isoWeekday(day))) return null;
  return {
    start: localMinuteToUtc(day, schedule.workStartMinute, schedule.workTimeZone),
    end: localMinuteToUtc(day, schedule.workEndMinute, schedule.workTimeZone),
  };
}

export function assertWorkSchedule(schedule: TaskWorkSchedule) {
  if (!Array.isArray(schedule.workDays) || !schedule.workDays.length
      || new Set(schedule.workDays).size !== schedule.workDays.length
      || schedule.workDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RangeError('Select at least one valid workday without duplicates');
  }
  if (!Number.isInteger(schedule.workStartMinute) || !Number.isInteger(schedule.workEndMinute)
      || schedule.workStartMinute < 0 || schedule.workEndMinute > 1439
      || schedule.workEndMinute <= schedule.workStartMinute) {
    throw new RangeError('Work hours must be within one day, with an end after the start');
  }
  formatter(schedule.workTimeZone).format(new Date());
}

export function addWorkingMinutes(from: Date, minutes: number, schedule: TaskWorkSchedule): Date {
  assertWorkSchedule(schedule);
  if (!Number.isFinite(from.getTime()) || !Number.isInteger(minutes) || minutes < 0) {
    throw new RangeError('A valid start and nonnegative whole minutes are required');
  }
  if (minutes === 0) return new Date(from);
  let cursor = new Date(from);
  let remaining = minutes * 60_000;
  for (let count = 0; count < 1500; count++) {
    const local = localParts(cursor, schedule.workTimeZone);
    const day = { year: local.year, month: local.month, day: local.day };
    const window = windowFor(day, schedule);
    if (window) {
      if (cursor < window.start) cursor = window.start;
      if (cursor < window.end) {
        const available = window.end.getTime() - cursor.getTime();
        if (remaining <= available) return new Date(cursor.getTime() + remaining);
        remaining -= available;
      }
    }
    const tomorrow = nextDay(day);
    cursor = localMinuteToUtc(tomorrow, schedule.workStartMinute, schedule.workTimeZone);
  }
  throw new RangeError('The delivery window exceeds the supported calendar range');
}

export function workingMinutesBetween(from: Date, to: Date, schedule: TaskWorkSchedule): number {
  assertWorkSchedule(schedule);
  if (to <= from) return 0;
  let day: LocalDay = (() => {
    const local = localParts(from, schedule.workTimeZone);
    return { year: local.year, month: local.month, day: local.day };
  })();
  let milliseconds = 0;
  for (let count = 0; count < 1500; count++) {
    const window = windowFor(day, schedule);
    if (window) {
      const start = Math.max(from.getTime(), window.start.getTime());
      const end = Math.min(to.getTime(), window.end.getTime());
      if (end > start) milliseconds += end - start;
    }
    const tomorrow = nextDay(day);
    const nextStart = localMinuteToUtc(tomorrow, schedule.workStartMinute, schedule.workTimeZone);
    if (nextStart >= to) return Math.ceil(milliseconds / 60_000);
    day = tomorrow;
  }
  throw new RangeError('The period exceeds the supported calendar range');
}
