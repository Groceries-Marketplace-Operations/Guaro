import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addWorkingMinutes, assertWorkSchedule, workingMinutesBetween } from '../src/tasks/business-time';

const mexico = {
  workDays: [1, 2, 3, 4, 5],
  workStartMinute: 9 * 60,
  workEndMinute: 18 * 60,
  workTimeZone: 'America/Mexico_City',
};

test('delivery time skips Friday evening and the weekend', () => {
  const start = new Date('2026-11-13T23:30:00.000Z'); // Friday 17:30 Mexico City
  const due = addWorkingMinutes(start, 60, mexico);
  assert.equal(due.toISOString(), '2026-11-16T15:30:00.000Z'); // Monday 09:30
  assert.equal(workingMinutesBetween(start, due, mexico), 60);
  assert.equal(workingMinutesBetween(due, new Date('2026-11-16T17:00:00.000Z'), mexico), 90);
});

test('a task assigned on a rest day begins at the next work window', () => {
  const due = addWorkingMinutes(new Date('2026-11-14T18:00:00.000Z'), 60, mexico);
  assert.equal(due.toISOString(), '2026-11-16T16:00:00.000Z');
});

test('Saturday can be explicitly enabled', () => {
  const due = addWorkingMinutes(new Date('2026-11-13T23:30:00.000Z'), 60,
    { ...mexico, workDays: [1, 2, 3, 4, 5, 6] });
  assert.equal(due.toISOString(), '2026-11-14T15:30:00.000Z');
});

test('calendar uses configured time zone', () => {
  const bogota = { ...mexico, workTimeZone: 'America/Bogota' };
  const due = addWorkingMinutes(new Date('2026-11-13T22:30:00.000Z'), 60, bogota);
  assert.equal(due.toISOString(), '2026-11-16T14:30:00.000Z');
});

test('invalid schedules cannot be saved', () => {
  assert.throws(() => assertWorkSchedule({ ...mexico, workDays: [] }));
  assert.throws(() => assertWorkSchedule({ ...mexico, workDays: [1, 1] }));
  assert.throws(() => assertWorkSchedule({ ...mexico, workEndMinute: 8 * 60 }));
  assert.throws(() => assertWorkSchedule({ ...mexico, workTimeZone: 'Mars/Phobos' }));
});
