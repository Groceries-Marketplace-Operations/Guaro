import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Country, FileIntegrationKind } from '@prisma/client';
import { UpsertFileIntegrationRuleDto } from '../src/file-integrations/dto/upsert-file-integration-rule.dto';
import { cityClubFileMatches, filesModifiedToday, filterSftpRows, parseSftpFilterMode, priceFilterTimeZone, sorianaShopIdFromFileName } from '../src/file-integrations/file-integration.util';
import { FileIntegrationsService } from '../src/file-integrations/file-integrations.service';

test('code-only filter removes exact codes and leaves all other amounts untouched', () => {
  const result = filterSftpRows(
    ['000123|999999', '123|999999', '673123464.0|invalid', '1234|10', 'not-a-code|5000000', ''],
    '|',
    {
      filterMode: 'code',
      upcColumn: 0,
      excludedUpcs: ['"000123"', '673123464', '1234'],
      priceColumn: null,
      thresholdAmount: null,
    },
  );
  assert.deepEqual(result.kept, ['123|999999', 'not-a-code|5000000', '']);
  assert.equal(result.rowsRemovedByUpc, 3);
  assert.equal(result.rowsRemovedByAmount, 0);
  assert.equal(result.invalidAmounts, 0);
});

test('combined mode removes listed codes first, then values over the amount threshold', () => {
  const result = filterSftpRows(
    ['1001|500', '1002|101', '1003|100', '1004|bad'],
    '|',
    {
      filterMode: 'amount_and_code',
      upcColumn: 0,
      excludedUpcs: ['1001'],
      priceColumn: 1,
      thresholdAmount: 100,
    },
  );
  assert.deepEqual(result.kept, ['1003|100', '1004|bad']);
  assert.equal(result.rowsRemovedByUpc, 1);
  assert.equal(result.rowsRemovedByAmount, 1);
  assert.equal(result.invalidAmounts, 1);
});

test('amount-only mode does not remove selected codes', () => {
  const result = filterSftpRows(['1001|50'], '|', {
    filterMode: 'amount',
    upcColumn: 0,
    excludedUpcs: ['1001'],
    priceColumn: 1,
    thresholdAmount: 100,
  });
  assert.equal(result.rowsKept, 1);
  assert.equal(result.rowsRemovedByUpc, 0);
  assert.deepEqual(result.kept, ['1001|50']);
});

test('unknown or incomplete code filters fail before any file replacement', () => {
  assert.throws(() => parseSftpFilterMode('unknown'), /Unsupported SFTP filter mode/);
  assert.throws(() => filterSftpRows(['1001|5'], '|', {
    filterMode: 'code', upcColumn: null, excludedUpcs: ['1001'],
    priceColumn: null, thresholdAmount: null,
  }), /missing its column or codes/);
});

test('today means the current date in the rule country, not the server date', () => {
  const now = new Date('2026-11-19T06:20:00Z');
  const files = [
    { name: 'older.csv', modifyTime: Date.parse('2026-11-19T04:59:00Z') },
    { name: 'bogota-only.csv', modifyTime: Date.parse('2026-11-19T05:30:00Z') },
    { name: 'both.csv', modifyTime: Date.parse('2026-11-19T06:10:00Z') },
    { name: 'invalid.csv', modifyTime: Number.NaN },
  ];
  assert.deepEqual(filesModifiedToday(files, now, priceFilterTimeZone(Country.CO)).map(file => file.name),
    ['bogota-only.csv', 'both.csv']);
  assert.deepEqual(filesModifiedToday(files, now, priceFilterTimeZone(Country.MX)).map(file => file.name),
    ['both.csv']);
});

test('City Club files use the store ID in Soriana filenames, even without a text marker', () => {
  const ids = new Set(['1032', '1001']);
  assert.equal(sorianaShopIdFromFileName('preciosdidi_suc_01032_20261118_3.csv'), '1032');
  assert.equal(cityClubFileMatches('preciosdidi_suc_1032_20261118_3.csv', ids), true);
  assert.equal(cityClubFileMatches('preciosdidi_suc_692_20261118_3.csv', ids), false);
  assert.equal(cityClubFileMatches('cityclub_special.csv', ids), true);
  assert.equal(cityClubFileMatches('preciosdidi_unrecognized.csv', ids), false);
});

test('City Club scope is rejected for Colombia and retained for Mexico', async () => {
  const saved: Record<string, unknown>[] = [];
  const service = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: 'sftp-app', name: 'Soriana', active: true }) },
    fileIntegrationRule: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { saved.push(data); return data; },
    },
  } as never, {} as never);
  const rule = {
    name: 'Store amount filter', kind: FileIntegrationKind.price_filter,
    sftpApplicationId: '11111111-1111-4111-8111-111111111111',
    intervalMinutes: 60, sourceScope: 'city_club', filterMode: 'amount',
    thresholdAmount: 3000, priceColumn: 4,
  };
  await assert.rejects(service.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    ...rule, country: Country.CO,
  }), 'operator'), /City Club scope is available only for Mexico/);
  assert.equal(saved.length, 0);
  await service.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    ...rule, country: Country.MX,
  }), 'operator');
  assert.equal(saved[0].sourceScope, 'city_club');
  assert.equal(saved[0].timezone, 'America/Mexico_City');
  const wrongAccount = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: 'sftp-app', name: 'Cencosud', active: true }) },
  } as never, {} as never);
  await assert.rejects(wrongAccount.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    ...rule, country: Country.MX,
  }), 'operator'), /requires the Soriana SFTP account/);
});

test('rule DTO accepts 100,000 codes with leading zeros and rejects 100,001', () => {
  const codes = Array.from({ length: 100_000 }, (_, index) => String(index).padStart(12, '0'));
  const dto = plainToInstance(UpsertFileIntegrationRuleDto, {
    name: 'Cencosud code filter',
    kind: FileIntegrationKind.price_filter,
    country: Country.CO,
    sftpApplicationId: '11111111-1111-4111-8111-111111111111',
    intervalMinutes: 60,
    filterMode: 'code',
    upcColumn: 0,
    excludedUpcs: codes,
    maxFilesPerRun: 250,
  });
  assert.deepEqual(validateSync(dto), []);
  assert.equal(dto.excludedUpcs?.[0], '000000000000');
  dto.excludedUpcs = [...codes, '000000100000'];
  assert.ok(validateSync(dto).some(error => error.property === 'excludedUpcs' && error.constraints?.arrayMaxSize));
});

test('code-only rule saves code matching without requiring any amount field', async () => {
  let saved: Record<string, unknown> | undefined;
  const service = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: 'sftp-app' }) },
    fileIntegrationRule: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { saved = data; return data; },
    },
  } as never, {} as never);
  await service.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    name: 'Cencosud code filter',
    kind: FileIntegrationKind.price_filter,
    country: Country.CO,
    sftpApplicationId: '11111111-1111-4111-8111-111111111111',
    intervalMinutes: 60,
    filterMode: 'code',
    upcColumn: 0,
    excludedUpcs: ['"000123"', '000123', '673123464'],
  }), 'operator');
  assert.equal(saved?.filterMode, 'code');
  assert.equal(saved?.thresholdAmount, null);
  assert.equal(saved?.priceColumn, null);
  assert.deepEqual(saved?.excludedUpcs, ['000123', '673123464']);
  assert.equal(saved?.upcColumn, 0);
  assert.equal(saved?.timezone, 'America/Bogota');
});

test('legacy rule creation with selected codes preserves combined filtering', async () => {
  let saved: Record<string, unknown> | undefined;
  const service = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: 'sftp-app' }) },
    fileIntegrationRule: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { saved = data; return data; },
    },
  } as never, {} as never);
  await service.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    name: 'Existing mixed filter',
    kind: FileIntegrationKind.price_filter,
    country: Country.CO,
    sftpApplicationId: '11111111-1111-4111-8111-111111111111',
    intervalMinutes: 60,
    thresholdAmount: 500,
    priceColumn: 4,
    upcColumn: 1,
    excludedUpcs: ['673123464'],
  }), 'operator');
  assert.equal(saved?.filterMode, 'amount_and_code');
});

test('an inactive SFTP account can be configured but cannot enable a processing rule', async () => {
  let created = 0;
  const service = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: 'sftp-app', active: false }) },
    fileIntegrationRule: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created++; return data; },
    },
  } as never, {} as never);
  const rule = {
    name: 'Cencosud UPC filter',
    kind: FileIntegrationKind.price_filter,
    country: Country.CO,
    sftpApplicationId: '11111111-1111-4111-8111-111111111111',
    intervalMinutes: 60,
    filterMode: 'code',
    upcColumn: 0,
    excludedUpcs: ['673123464'],
  };

  await assert.rejects(
    service.create(plainToInstance(UpsertFileIntegrationRuleDto, { ...rule, active: true }), 'operator'),
    /Activate the SFTP application before enabling this processing rule/,
  );
  assert.equal(created, 0);
  const inactive = await service.create(plainToInstance(UpsertFileIntegrationRuleDto, { ...rule, active: false }), 'operator');
  assert.equal(inactive.active, false);
  assert.equal(created, 1);
});

test('a second processing rule cannot target the same SFTP account, file pattern and scope', async () => {
  let created = false;
  const appId = '11111111-1111-4111-8111-111111111111';
  const service = new FileIntegrationsService({
    sftpApplication: { findFirst: async () => ({ id: appId, active: false }) },
    fileIntegrationRule: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.deepEqual(where, {
          kind: FileIntegrationKind.price_filter,
          deletedAt: null,
          sftpApplicationId: appId,
          filePattern: '*',
          sourceScope: 'all',
        });
        return { id: 'existing-rule', name: 'Cencosud CO Amount Guard' };
      },
      create: async () => { created = true; },
    },
  } as never, {} as never);

  await assert.rejects(service.create(plainToInstance(UpsertFileIntegrationRuleDto, {
    name: 'Another Cencosud filter',
    kind: FileIntegrationKind.price_filter,
    country: Country.CO,
    sftpApplicationId: appId,
    intervalMinutes: 30,
    filePattern: '*',
    sourceScope: 'all',
    filterMode: 'amount',
    thresholdAmount: 374000,
    priceColumn: 4,
  }), 'operator'), /Edit the existing rule instead/);
  assert.equal(created, false);
});

test('editing a processing SFTP rule is blocked before resetting its file states', async () => {
  let resetCalled = false;
  const service = new FileIntegrationsService({
    fileIntegrationRule: {
      findFirst: async () => ({ id: 'rule-1', kind: FileIntegrationKind.price_filter, filterMode: 'amount' }),
    },
    fileIntegrationExecution: { count: async () => 1 },
    $transaction: async () => { resetCalled = true; },
  } as never, {} as never);
  await assert.rejects(service.update('rule-1', plainToInstance(UpsertFileIntegrationRuleDto, {
    name: 'Changed',
    kind: FileIntegrationKind.price_filter,
  })), /Stop the active SFTP processing execution/);
  assert.equal(resetCalled, false);
});
