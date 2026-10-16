import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StepStatus, TaskStatus } from '@prisma/client';
import { BpoManagementService } from '../src/bpo-management/bpo-management.service';

type CountInput = {
  where: {
    assignedToId: string;
    status: StepStatus | { in: StepStatus[] };
    task?: { status?: { not?: TaskStatus }; taskTypeId?: string; createdAt?: unknown };
  };
};

function fixture() {
  const countInputs: CountInput[] = [];
  let rawSql = '';
  const prisma = {
    stepInstance: {
      count: async (input: CountInput) => {
        countInputs.push(input);
        assert.equal(input.where.task?.status?.not, TaskStatus.failed);
        if (input.where.status === StepStatus.done) return 7;
        if (input.where.status === StepStatus.failed) return 2;
        return 3;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      rawSql = strings.join(' ');
      return [{ avg_hours: 1.5 }];
    },
  };

  return {
    service: new BpoManagementService(prisma as never),
    observed: () => ({ countInputs, rawSql }),
  };
}

test('BPO people metrics exclude every step that belongs to a failed task', async () => {
  const { service, observed } = fixture();

  const result = await service.myPerformance('11111111-1111-4111-8111-111111111111');

  assert.deepEqual(result, {
    stepsCompleted: 7,
    stepsFailed: 2,
    stepsInProgress: 3,
    avgCompletionHours: 1.5,
  });
  assert.equal(observed().countInputs.length, 3);
  for (const input of observed().countInputs) {
    assert.equal(input.where.task?.status?.not, TaskStatus.failed);
  }
});

test('average completion time joins the parent task and excludes failed tasks', async () => {
  const { service, observed } = fixture();

  await service.myPerformance('11111111-1111-4111-8111-111111111111');

  assert.match(observed().rawSql, /JOIN task t ON t\.id = si\.task_id/);
  assert.match(observed().rawSql, /t\.estado <> 'failed'/);
});
