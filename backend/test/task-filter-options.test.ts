import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AccountRole, Country, FormFieldTipo } from '@prisma/client';
import { TasksService } from '../src/tasks/tasks.service';

test('task filter brands are derived from the viewer task scope', async () => {
  const taskScope = { AND: [{ createdById: 'account-1' }] };
  let taskTypeQuery: Record<string, unknown> | undefined;
  let brandQuery: Record<string, unknown> | undefined;
  let formCountryQuery: Record<string, unknown> | undefined;
  const prisma = {
    section: {
      findMany: async () => [{ id: 'section-1', name: 'Operations', order: 1 }],
    },
    taskType: {
      findMany: async (args: Record<string, unknown>) => {
        taskTypeQuery = args;
        return [{
          id: 'task-type-1',
          name: 'Create Stores',
          sectionId: 'section-1',
          order: 2,
          section: { name: 'Operations' },
        }];
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
    formValue: {
      findMany: async (args: Record<string, unknown>) => {
        formCountryQuery = args;
        return [{ valor: Country.CR }, { valor: Country.MX }, { valor: 'UNKNOWN' }];
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
  assert.deepEqual(result.taskTypes, [{
    id: 'task-type-1',
    name: 'Create Stores',
    sectionId: 'section-1',
    order: 2,
    section: { name: 'Operations' },
  }]);
  assert.deepEqual(result.countries, [Country.CO, Country.CR, Country.MX]);
  assert.deepEqual(taskTypeQuery, {
    where: { tasks: { some: taskScope } },
    select: {
      id: true,
      name: true,
      sectionId: true,
      order: true,
      section: { select: { name: true } },
    },
    orderBy: [{ name: 'asc' }, { order: 'asc' }],
  });
  assert.deepEqual(brandQuery, {
    where: { tasks: { some: taskScope } },
    select: { id: true, brandId: true, brandName: true, country: true },
    orderBy: [{ brandName: 'asc' }, { id: 'asc' }],
  });
  assert.deepEqual(formCountryQuery, {
    where: {
      task: { AND: [taskScope, { brandId: null }] },
      formField: { tipo: FormFieldTipo.select_country },
      valor: { not: null },
    },
    select: { valor: true },
    distinct: ['valor'],
  });
});

test('task filter options return empty scoped collections when the viewer has no visible tasks', async () => {
  const taskScope = { AND: [] };
  let taskTypeQuery: Record<string, unknown> | undefined;
  let brandQuery: Record<string, unknown> | undefined;
  let formCountryQuery: Record<string, unknown> | undefined;
  const prisma = {
    section: { findMany: async () => [] },
    taskType: {
      findMany: async (args: Record<string, unknown>) => {
        taskTypeQuery = args;
        return [];
      },
    },
    brand: {
      findMany: async (args: Record<string, unknown>) => {
        brandQuery = args;
        return [];
      },
    },
    formValue: {
      findMany: async (args: Record<string, unknown>) => {
        formCountryQuery = args;
        return [];
      },
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
    { accessibleSectionIds: async () => [] } as never,
    {} as never,
  );
  (service as unknown as { taskWhere: () => Promise<Record<string, unknown>> }).taskWhere = async () => taskScope;

  const result = await service.filterOptions([AccountRole.user], 'account-1', null);

  assert.deepEqual(result, { sections: [], brands: [], taskTypes: [], countries: [] });
  assert.deepEqual(taskTypeQuery?.where, { tasks: { some: taskScope } });
  assert.deepEqual(brandQuery?.where, { tasks: { some: taskScope } });
  assert.deepEqual(formCountryQuery?.where, {
    task: { AND: [taskScope, { brandId: null }] },
    formField: { tipo: FormFieldTipo.select_country },
    valor: { not: null },
  });
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
