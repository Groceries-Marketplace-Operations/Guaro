import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AccountRole } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
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

test('pure BPO task list is the union of tasks created by or assigned to that BPO', async () => {
  let where: Record<string, unknown> | undefined;
  const prisma = {
    task: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        where = args.where;
        return [];
      },
      count: async () => 0,
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    { accessibleSectionIds: async () => ['home-section'] } as never,
  );

  await service.findAll([AccountRole.bpo], 'bpo-1', 'home-section');

  assert.ok(where);
  assert.deepEqual(where.AND, [
    { deletedAt: null },
    {
      OR: [
        { stepInstances: { some: { assignedToId: 'bpo-1' } } },
        { createdById: 'bpo-1' },
      ],
    },
  ]);
});

test('an admin that also has the BPO role keeps its privileged section scope', async () => {
  let where: Record<string, unknown> | undefined;
  const prisma = {
    task: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        where = args.where;
        return [];
      },
      count: async () => 0,
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    { accessibleSectionIds: async () => ['home-section'] } as never,
  );

  await service.findAll(
    [AccountRole.admin, AccountRole.bpo],
    'admin-bpo-1',
    'home-section',
  );

  assert.ok(where);
  assert.deepEqual(where.AND, [
    { deletedAt: null },
    { taskType: { sectionId: { in: ['home-section'] } } },
  ]);
});

test('pure BPO can open tasks it created or was assigned across sections, but not unrelated tasks', async () => {
  const viewerId = '11111111-1111-4111-8111-111111111111';
  const taskId = '22222222-2222-4222-8222-222222222222';
  let task: {
    id: string;
    deletedAt: null;
    createdById: string;
    taskType: { sectionId: string };
    stepInstances: Array<{ assignedToId: string | null }>;
  } = {
    id: taskId,
    deletedAt: null,
    createdById: viewerId,
    taskType: { sectionId: 'foreign-section' },
    stepInstances: [{ assignedToId: null }],
  };
  let sectionAccessChecks = 0;
  const prisma = {
    task: { findUnique: async () => task },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    {
      canAccess: async () => {
        sectionAccessChecks += 1;
        return false;
      },
    } as never,
  );
  const viewer = {
    roles: [AccountRole.bpo],
    accountId: viewerId,
    sectionId: 'home-section',
  };

  assert.equal(await service.findOne(taskId, viewer), task);
  task = {
    ...task,
    createdById: '33333333-3333-4333-8333-333333333333',
    stepInstances: [{ assignedToId: viewerId }],
  };
  assert.equal(await service.findOne(taskId, viewer), task);
  assert.equal(sectionAccessChecks, 0, 'a direct creator/assignee relationship must be the narrow task grant');

  task = { ...task, stepInstances: [{ assignedToId: null }] };
  await assert.rejects(
    service.findOne(taskId, viewer),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(sectionAccessChecks, 0, 'unrelated BPOs must be rejected before section access can broaden visibility');

  task = { ...task, createdById: viewerId };
  await assert.rejects(
    service.findOne(taskId, {
      ...viewer,
      roles: [AccountRole.admin, AccountRole.bpo],
    }),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(sectionAccessChecks, 1, 'a privileged mixed-role account must still pass section authorization');
});
