import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SftpProcessingRetentionService } from '../src/file-integrations/sftp-processing-retention.service';

const executionId = '11111111-1111-4111-8111-111111111111';
const rootPath = '/upload';
const fileName = 'menu_123.csv';
const originalPath = `${rootPath}/${fileName}`;
const backupDirectory = `${rootPath}/.tequila-backup/${executionId}`;
const backupPath = `${backupDirectory}/${fileName}`;

function fixture(originalExists: boolean, scheduledJobsEnabled = true) {
  const deletedPaths: string[] = [];
  let deletedExecutions = 0;
  const execution = {
    id: executionId,
    rule: { sftpApplicationId: '22222222-2222-4222-8222-222222222222' },
    result: { files: [{ fileName, backupRemotePath: backupPath }] },
  };
  const client = {
    exists: async (path: string) => path === originalPath ? (originalExists ? '-' : false)
      : path === backupPath ? '-' : path === backupDirectory ? 'd' : false,
    delete: async (path: string) => { deletedPaths.push(path); },
    list: async () => [],
    rmdir: async (path: string) => { deletedPaths.push(path); },
  };
  const prisma = {
    fileIntegrationExecution: {
      findMany: async () => [execution],
      deleteMany: async () => { deletedExecutions += 1; },
    },
  };
  const sftp = {
    withClient: async (_accountId: string, action: (connection: typeof client, root: string) => Promise<void>) => action(client, rootPath),
    safeRemotePath: (_root: string, name: string) => `${rootPath}/${name}`,
  };
  const config = { get: () => scheduledJobsEnabled ? 'true' : 'false' };
  const service = new SftpProcessingRetentionService(prisma as never, sftp as never, config as never);
  return { service, deletedPaths, get deletedExecutions() { return deletedExecutions; } };
}

test('retention removes a known old backup only while its original exists', async () => {
  const scenario = fixture(true);
  await scenario.service.prune();
  assert.deepEqual(scenario.deletedPaths, [backupPath, backupDirectory]);
  assert.equal(scenario.deletedExecutions, 1);
});

test('retention preserves the backup and report if the original is missing', async () => {
  const scenario = fixture(false);
  await scenario.service.prune();
  assert.deepEqual(scenario.deletedPaths, []);
  assert.equal(scenario.deletedExecutions, 0);
});

test('retention stays off in the isolated local mirror', async () => {
  const scenario = fixture(true, false);
  await scenario.service.prune();
  assert.deepEqual(scenario.deletedPaths, []);
  assert.equal(scenario.deletedExecutions, 0);
});
