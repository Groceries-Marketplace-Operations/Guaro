import { nextDailyRun } from './auto-fetch-time.util';

export type AutoTurnOffScheduleMode = 'interval' | 'daily_times';

interface NextOccurrenceOptions {
  startsAt: Date;
  intervalMinutes: number;
  scheduleMode: AutoTurnOffScheduleMode | string;
  executionTimes: string[];
  timezone: string;
  after?: Date;
}

export function nextAutoTurnOffOccurrence({
  startsAt,
  intervalMinutes,
  scheduleMode,
  executionTimes,
  timezone,
  after = new Date(),
}: NextOccurrenceOptions) {
  if (scheduleMode !== 'daily_times') {
    if (startsAt.getTime() >= after.getTime()) return startsAt;
    const intervalMs = intervalMinutes * 60_000;
    const elapsed = after.getTime() - startsAt.getTime();
    return new Date(startsAt.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
  }

  if (executionTimes.length === 0) throw new Error('At least one daily execution time is required');
  const boundary = new Date(Math.max(after.getTime(), startsAt.getTime()) - 1);
  return executionTimes
    .map(value => value.split(':').map(Number))
    .map(([hour, minute]) => nextDailyRun(boundary, hour, minute, timezone))
    .filter(candidate => candidate >= startsAt && candidate >= after)
    .sort((left, right) => left.getTime() - right.getTime())[0];
}
