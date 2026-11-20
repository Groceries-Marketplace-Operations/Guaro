import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AutoTurnOffService } from '../src/integrations/auto-turn-off.service';
import { CreateAutoTurnOffRuleDto } from '../src/integrations/dto/create-auto-turn-off-rule.dto';

const userId = '399934cf-7a51-4269-b294-2218be729061';
const otherId = '9472104c-074c-4437-80fc-1e8381d7b480';
const brandId = '130b2568-8f6b-4645-9511-0180d71f0e0f';
const poolId = 'dd3ed22d-d9bb-4bdf-af82-fbfb80e7f901';
const shopId = '5764607795237028465';

function fixture() {
  let saved: Record<string, unknown> | undefined;
  const prisma = {
    autoTurnOffPool: { findUnique: async () => ({ id: poolId, country: 'MX' }) },
    brand: { findFirst: async () => ({ id: brandId, country: 'MX' }) },
    autoTurnOffRule: {
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => { saved = args.data; return args.data; },
    },
    account: {
      findMany: async () => [
        { id: userId, name: 'Daniel', email: 'daniel@example.com', deletedAt: null, sectionId: null, roles: ['super_admin'] },
        { id: otherId, name: 'Natalia', email: 'natalia@example.com', deletedAt: null, sectionId: null, roles: ['admin'] },
      ],
    },
  };
  const service = new AutoTurnOffService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  return { service, saved: () => saved };
}

const base = {
  name: 'Fragua', brandId, shopIds: [shopId], stockEndpoint: 'setStock' as const,
  intervalMinutes: 10, startsAt: '2026-11-21T12:00:00.000Z',
};

test('two responsible UPC groups create one rule with one deduplicated stock target list', async () => {
  const { service, saved } = fixture();
  await service.createRule(poolId, {
    ...base,
    upcGroups: [
      { name: 'Daniel', responsibleId: userId, upcs: ['75001', '75002'] },
      { name: 'Natalia', responsibleId: otherId, upcs: ['75003'] },
    ],
  }, userId);
  assert.deepEqual(saved()?.upcs, ['75001', '75002', '75003']);
  assert.deepEqual((saved()?.upcGroups as Array<{ responsibleName: string }>).map(group => group.responsibleName), ['Daniel', 'Natalia']);
});

test('the same UPC cannot be assigned to two active people', async () => {
  const { service } = fixture();
  await assert.rejects(service.createRule(poolId, {
    ...base,
    upcGroups: [
      { name: 'Daniel', responsibleId: userId, upcs: ['75001'] },
      { name: 'Natalia', responsibleId: otherId, upcs: ['75001'] },
    ],
  }, userId), /belongs to more than one active group/);
});

test('create DTO accepts grouped UPCs without a legacy UPC list', () => {
  const dto = plainToInstance(CreateAutoTurnOffRuleDto, {
    ...base,
    upcGroups: [{ name: 'Daniel', responsibleId: userId, upcs: ['75001'] }],
  });
  assert.deepEqual(validateSync(dto).map(error => error.property), []);
});

test('editing a legacy rule preserves its original owner and merges a second owner without a second rule', async () => {
  const ruleId = '0560cbfb-7cb1-47f7-88ea-526144b6b44c';
  const current = {
    id: ruleId, poolId, brandId, name: 'Fragua', active: true,
    shopIds: [shopId], upcs: ['75001'], upcGroups: null,
    configVersion: 3, createdById: userId, updatedById: userId,
    createdBy: { id: userId, name: 'Daniel', email: 'daniel@example.com' },
    updatedBy: { id: userId, name: 'Daniel', email: 'daniel@example.com' },
    createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-20T00:00:00Z'),
    stockEndpoint: 'setStock', stockValue: 0, intervalMinutes: 10,
    scheduleMode: 'interval', executionTimes: [],
    startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: null,
  };
  let update: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
  const prisma = {
    autoTurnOffPool: { findUnique: async () => ({ id: poolId, country: 'MX' }) },
    brand: { findFirst: async () => ({ id: brandId, country: 'MX' }) },
    autoTurnOffRule: {
      findUnique: async () => current,
      findMany: async () => [],
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { update = args; return args.data; },
    },
    account: { findMany: async () => [
      { id: userId, name: 'Daniel', email: 'daniel@example.com', deletedAt: null, sectionId: null, roles: ['super_admin'] },
      { id: otherId, name: 'Natalia', email: 'natalia@example.com', deletedAt: null, sectionId: null, roles: ['admin'] },
    ] },
  };
  const service = new AutoTurnOffService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  await service.updateRule(ruleId, {
    expectedConfigVersion: 3,
    upcGroups: [
      { id: ruleId, name: 'Original', responsibleId: userId, upcs: ['75001'] },
      { name: 'Otra lista', responsibleId: otherId, upcs: ['75002'] },
    ],
  }, userId);
  assert.deepEqual(update?.where, { id: ruleId, configVersion: 3 });
  assert.deepEqual(update?.data.upcs, ['75001', '75002']);
  assert.deepEqual((update?.data.upcGroups as Array<{ responsibleId: string }>).map(group => group.responsibleId), [userId, otherId]);
  assert.deepEqual(update?.data.configVersion, { increment: 1 });
});
