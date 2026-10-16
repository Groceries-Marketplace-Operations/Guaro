import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  TaskTypeReleaseActivationService,
  UPDATE_STORE_LOGO_DESCRIPTION,
  UPDATE_STORE_LOGO_RELEASE_GATE_DELETED_AT,
  UPDATE_STORE_LOGO_RELEASE_GATE_MARKER,
  UPDATE_STORE_LOGO_TASK_TYPE_ID,
  UPDATE_STORE_LOGO_TASK_TYPE_NAME,
} from '../src/task-types/task-type-release-activation.service';

test('startup consumes the exact release gate and activates Update Store Logo atomically', async () => {
  const calls: unknown[] = [];
  const prisma = {
    taskType: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count: 1 };
      },
    },
  };

  await new TaskTypeReleaseActivationService(prisma as never).onApplicationBootstrap();

  assert.deepEqual(calls, [{
    where: {
      id: UPDATE_STORE_LOGO_TASK_TYPE_ID,
      name: UPDATE_STORE_LOGO_TASK_TYPE_NAME,
      descripcion: UPDATE_STORE_LOGO_RELEASE_GATE_MARKER,
      schedulable: false,
      active: false,
      deletedAt: UPDATE_STORE_LOGO_RELEASE_GATE_DELETED_AT,
    },
    data: {
      descripcion: UPDATE_STORE_LOGO_DESCRIPTION,
      active: true,
      deletedAt: null,
    },
  }]);
});

test('a later admin disable or delete is not undone after the release gate was consumed', async () => {
  const row = {
    id: UPDATE_STORE_LOGO_TASK_TYPE_ID,
    name: UPDATE_STORE_LOGO_TASK_TYPE_NAME,
    descripcion: UPDATE_STORE_LOGO_RELEASE_GATE_MARKER,
    schedulable: false,
    active: false,
    deletedAt: new Date(UPDATE_STORE_LOGO_RELEASE_GATE_DELETED_AT),
  };
  const prisma = {
    taskType: {
      updateMany: async (args: {
        where: typeof row;
        data: Partial<typeof row>;
      }) => {
        const matches = row.id === args.where.id
          && row.name === args.where.name
          && row.descripcion === args.where.descripcion
          && row.schedulable === args.where.schedulable
          && row.active === args.where.active
          && row.deletedAt?.getTime() === args.where.deletedAt.getTime();
        if (!matches) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };

  const service = new TaskTypeReleaseActivationService(prisma as never);
  await service.onApplicationBootstrap();
  assert.equal(row.active, true);
  assert.equal(row.deletedAt, null);
  assert.equal(row.descripcion, UPDATE_STORE_LOGO_DESCRIPTION);

  row.active = false;
  await service.onApplicationBootstrap();
  assert.equal(row.active, false);

  row.deletedAt = new Date();
  await service.onApplicationBootstrap();
  assert.equal(row.active, false);
  assert.notEqual(row.deletedAt, null);
});

test('startup leaves an edited release marker inactive and deleted', async () => {
  const calls: unknown[] = [];
  const prisma = {
    taskType: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count: 0 };
      },
    },
  };

  await new TaskTypeReleaseActivationService(prisma as never).onApplicationBootstrap();

  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { data: unknown }).data, {
    descripcion: UPDATE_STORE_LOGO_DESCRIPTION,
    active: true,
    deletedAt: null,
  });
});

test('migration keeps Update Store Logo hidden behind the same release gate', async () => {
  const migration = await readFile(resolve(
    __dirname,
    '../../prisma/migrations/20261016010000_update_store_logo/migration.sql',
  ), 'utf8');

  assert.match(migration, new RegExp(UPDATE_STORE_LOGO_RELEASE_GATE_MARKER));
  assert.match(migration, /"programable", "activo", "created_at", "updated_at", "deleted_at"/);
  assert.match(migration, /FALSE,\s*FALSE,\s*CURRENT_TIMESTAMP,\s*CURRENT_TIMESTAMP,\s*TIMESTAMP '2999-01-01 00:00:00'/);
  assert.doesNotMatch(migration, /"activo"\s*=\s*TRUE/);
});
