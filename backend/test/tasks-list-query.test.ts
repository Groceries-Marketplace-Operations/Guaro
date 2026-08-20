import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AccountRole } from '@prisma/client';
import { TasksService } from '../src/tasks/tasks.service';

test('task list omits heavy notes, results and form payloads', async () => {
  let query: Record<string, unknown> | undefined;
  const prisma = {
    task: {
      findMany: async (args: Record<string, unknown>) => {
        query = args;
        return [];
      },
      count: async () => 0,
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (service as unknown as { taskWhere: () => Promise<Record<string, never>> }).taskWhere = async () => ({});

  const result = await service.findAll(
    [AccountRole.super_admin],
    'account-1',
    null,
    { page: 1, limit: 25 },
  );

  assert.deepEqual(result, { data: [], total: 0, page: 1, limit: 25 });
  assert.ok(query);
  const include = query.include as Record<string, unknown>;
  assert.equal(include.formValues, undefined);
  assert.equal(include.taskShops, undefined);

  const stepInstances = include.stepInstances as {
    include?: unknown;
    select: Record<string, unknown>;
  };
  assert.equal(stepInstances.include, undefined);
  assert.equal(stepInstances.select.note, undefined);
  assert.equal(stepInstances.select.result, undefined);
  assert.equal(stepInstances.select.status, true);
  assert.equal(stepInstances.select.assignedToId, true);
});
