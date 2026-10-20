import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StepStatus, TaskStatus } from '@prisma/client';
import { BpoManagementService } from '../src/bpo-management/bpo-management.service';

test('BPO active work is the union of tasks created by or actively assigned to the account', async () => {
  let query: Record<string, unknown> | undefined;
  const prisma = {
    task: {
      findMany: async (args: Record<string, unknown>) => {
        query = args;
        return [
          {
            id: 'created-task',
            createdById: 'bpo-1',
            stepInstances: [{ assignedToId: 'bpo-2' }],
          },
          {
            id: 'assigned-task',
            createdById: 'bpo-2',
            stepInstances: [{ assignedToId: 'bpo-1' }],
          },
          {
            id: 'both-task',
            createdById: 'bpo-1',
            stepInstances: [{ assignedToId: 'bpo-1' }],
          },
        ];
      },
    },
  };
  const service = new BpoManagementService(prisma as never);

  const result = await service.myActiveTasks('bpo-1');
  assert.deepEqual(result.map(task => task.relationship), [
    { createdByMe: true, assignedToMe: false },
    { createdByMe: false, assignedToMe: true },
    { createdByMe: true, assignedToMe: true },
  ]);
  assert.ok(query);

  const activeStatuses = [StepStatus.pending, StepStatus.in_progress, StepStatus.blocked];
  assert.deepEqual(query.where, {
    deletedAt: null,
    status: { notIn: [TaskStatus.done, TaskStatus.failed, TaskStatus.scheduled] },
    OR: [
      { createdById: 'bpo-1' },
      {
        stepInstances: {
          some: {
            status: { in: activeStatuses },
            assignedToId: 'bpo-1',
          },
        },
      },
    ],
  });

  const include = query.include as Record<string, unknown>;
  assert.deepEqual(include.createdBy, {
    select: { id: true, name: true, email: true },
  });
  const steps = include.stepInstances as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
  };
  assert.deepEqual(steps.where, { status: { in: activeStatuses } });
  assert.equal(steps.select.id, true);
  assert.equal(steps.select.status, true);
  assert.equal(steps.select.assignedToId, true);
  assert.ok(steps.select.stepDefinition);
});
