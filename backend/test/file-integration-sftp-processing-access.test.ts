import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AccountRole, FileIntegrationKind } from '@prisma/client';
import { FileIntegrationsController } from '../src/file-integrations/file-integrations.controller';
import type { JwtUser } from '../src/auth/types/jwt-user.interface';

const user = (role: AccountRole) => ({ id: 'user-id', roles: [role], sectionId: null }) as JwtUser;

test('SFTP processing remains administrator-only even if another role has a permission override', async () => {
  const permissions: string[][] = [];
  const controller = new FileIntegrationsController(
    { list: async () => [] } as never,
    {} as never,
    { can: async (_user: JwtUser, required: string[]) => { permissions.push(required); return true; } } as never,
  );

  await assert.rejects(controller.list(FileIntegrationKind.price_filter, user(AccountRole.bpo)), ForbiddenException);
  assert.equal(permissions.length, 0);
  assert.deepEqual(await controller.list(FileIntegrationKind.price_filter, user(AccountRole.admin)), []);
  assert.deepEqual(permissions, [['integrations.sftp_processing']]);
});

test('SFTP account options use the processing permission and expose no credentials', async () => {
  const permissions: string[][] = [];
  const expected = [{ id: 'sftp-id', name: 'Cencosud', host: 'example.test', active: false }];
  const controller = new FileIntegrationsController(
    {} as never,
    { sftpApplication: { findMany: async (query: { select: Record<string, boolean> }) => {
      assert.deepEqual(query.select, { id: true, name: true, host: true, active: true });
      return expected;
    } } } as never,
    { can: async (_user: JwtUser, required: string[]) => { permissions.push(required); return true; } } as never,
  );

  await assert.rejects(controller.sftpOptions(user(AccountRole.bpo)), ForbiddenException);
  assert.deepEqual(await controller.sftpOptions(user(AccountRole.admin)), expected);
  assert.deepEqual(permissions, [['integrations.sftp_processing.configure']]);
});
