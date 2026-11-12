import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateTaskTypeDto } from '../src/task-types/dto/update-task-type.dto';

test('accepts the existing Operations section UUID when saving a delivery deadline', () => {
  const dto = plainToInstance(UpdateTaskTypeDto, {
    sectionId: '00000000-0000-0000-0000-000000000001',
    deliveryMinutes: 480,
    workDays: [1, 2, 3, 4, 5],
    workStartMinute: 540,
    workEndMinute: 1080,
    workTimeZone: 'America/Mexico_City',
  });
  assert.deepEqual(validateSync(dto), []);
});

test('rejects a malformed section UUID', () => {
  const dto = plainToInstance(UpdateTaskTypeDto, { sectionId: 'Operations' });
  assert.ok(validateSync(dto).some(error => error.property === 'sectionId'));
});
