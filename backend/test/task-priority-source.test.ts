import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateTaskDto } from '../src/tasks/dto/create-task.dto';
import { TasksService } from '../src/tasks/tasks.service';

test('task creation rejects a priority supplied by the requester', async () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  await assert.rejects(
    pipe.transform({ taskTypeId: randomUUID(), priority: 'urgent' }, { type: 'body', metatype: CreateTaskDto }),
    error => {
      assert.ok(error instanceof BadRequestException);
      const response = error.getResponse() as { message?: string[] };
      assert.ok(response.message?.includes('property priority should not exist'));
      return true;
    },
  );
});

test('task creation uses the task type priority even if called with a forged value', async () => {
  const taskTypeId = randomUUID();
  const createdId = randomUUID();
  let createdTask: Record<string, unknown> | undefined;
  const prisma = {
    taskType: { findUnique: async () => ({
      id: taskTypeId, deletedAt: null, schedulable: false,
      defaultPriority: 'high', formFields: [], stepDefinitions: [],
    }) },
    task: { findUnique: async () => createdTask },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      task: { create: async ({ data }: { data: Record<string, unknown> }) => {
        createdTask = { id: createdId, deletedAt: null, createdAt: new Date(), ...data };
        return createdTask;
      } },
    }),
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    { assertTaskTypeAccess: async () => {} } as never,
    {} as never,
  );

  const task = await service.create(
    { taskTypeId, priority: 'urgent' } as never,
    { id: randomUUID() } as never,
  );
  assert.equal(task.priority, 'high');
});
