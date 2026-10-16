import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AccountRole } from '@prisma/client';
import { TasksService } from '../src/tasks/tasks.service';

test('task filter brands are derived from the viewer task scope', async () => {
  const taskScope = { AND: [{ createdById: 'account-1' }] };
  let brandGroupQuery: Record<string, unknown> | undefined;
  let brandQuery: Record<string, unknown> | undefined;
  const prisma = {
    section: {
      findMany: async () => [{ id: 'section-1', name: 'Operations', order: 1 }],
    },
    task: {
      groupBy: async (args: Record<string, unknown>) => {
        brandGroupQuery = args;
        return [
          { brandId: 'brand-2' },
          { brandId: 'brand-1' },
        ];
      },
    },
    brand: {
      findMany: async (args: Record<string, unknown>) => {
        brandQuery = args;
        return [
          { id: 'brand-1', brandId: 'EXT-1', brandName: 'Alpha', country: 'CO' },
          { id: 'brand-2', brandId: 'EXT-2', brandName: 'Zulu', country: 'MX' },
        ];
      },
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    { accessibleSectionIds: async () => ['section-1'] } as never,
    {} as never,
  );
  (service as unknown as { taskWhere: () => Promise<typeof taskScope> }).taskWhere = async () => taskScope;

  const result = await service.filterOptions([AccountRole.user], 'account-1', 'section-1');

  assert.deepEqual(result.brands.map(brand => brand.brandName), ['Alpha', 'Zulu']);
  assert.deepEqual(brandGroupQuery?.where, {
    AND: [taskScope, { brandId: { not: null } }],
  });
  assert.deepEqual(brandGroupQuery?.by, ['brandId']);
  assert.deepEqual(brandQuery, {
    where: { id: { in: ['brand-2', 'brand-1'] } },
    select: { id: true, brandId: true, brandName: true, country: true },
    orderBy: [{ brandName: 'asc' }, { id: 'asc' }],
  });
});

test('task filter options skip the brand lookup when the task scope has no brands', async () => {
  let brandLookupCount = 0;
  const prisma = {
    section: { findMany: async () => [] },
    task: { groupBy: async () => [] },
    brand: { findMany: async () => { brandLookupCount += 1; return []; } },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    { accessibleSectionIds: async () => [] } as never,
    {} as never,
  );
  (service as unknown as { taskWhere: () => Promise<Record<string, unknown>> }).taskWhere = async () => ({ AND: [] });

  const result = await service.filterOptions([AccountRole.user], 'account-1', null);

  assert.deepEqual(result.brands, []);
  assert.equal(brandLookupCount, 0);
});

test('task shop options are bounded and search all supported store identifiers', async () => {
  let listQuery: Record<string, unknown> | undefined;
  let countQuery: Record<string, unknown> | undefined;
  const prisma = {
    shop: {
      findMany: async (args: Record<string, unknown>) => {
        listQuery = args;
        return [];
      },
      count: async (args: Record<string, unknown>) => {
        countQuery = args;
        return 0;
      },
    },
  };
  const service = new TasksService(prisma as never, {} as never, {} as never, {} as never, {} as never);

  const result = await service.shopOptions('brand-1', '  centro  ', 10_000);

  assert.equal(result.limit, 75);
  assert.equal(listQuery?.take, 75);
  assert.deepEqual(listQuery?.where, countQuery?.where);
  assert.deepEqual(listQuery?.where, {
    brandId: 'brand-1',
    deletedAt: null,
    OR: [
      { shopId: { contains: 'centro', mode: 'insensitive' } },
      { appShopId: { contains: 'centro', mode: 'insensitive' } },
      { name: { contains: 'centro', mode: 'insensitive' } },
      { city: { contains: 'centro', mode: 'insensitive' } },
    ],
  });
});
