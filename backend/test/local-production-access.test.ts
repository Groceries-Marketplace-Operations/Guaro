import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountRole, LocalProductionAccessAuditAction } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../src/auth/auth.controller';
import {
  issueLocalProductionAccess,
  revokeLocalProductionAccess,
  runLocalProductionAccessCli,
  validateIssueRequest,
  validateRevokeRequest,
  validateSshPrincipal,
  type LocalProductionAccessCommandDependencies,
} from '../src/auth/local-production-access.cli';
import { localProductionAccessSessionId } from '../src/auth/local-production-access-session';
import { JwtStrategy, type JwtPayload } from '../src/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/prisma/prisma.service';
import type { JwtUser } from '../src/auth/types/jwt-user.interface';

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters';
const SSH_PRINCIPAL = 'eduardo@example.com';
const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Production Operator',
  email: 'operator@didi-labs.com',
  roles: [AccountRole.admin],
  sectionId: null,
  adminModules: ['integrations'],
  bpoPermissions: [],
};

interface StoredSession {
  id: string;
  targetAccountId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function commandFixture() {
  let sessions = new Map<string, StoredSession>();
  let audits: Array<Record<string, unknown>> = [];
  let accountQuery: unknown;
  let failAudit = false;

  const data = {
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const transactionSessions = new Map(
        [...sessions.entries()].map(([id, session]) => [id, { ...session }]),
      );
      const transactionAudits = audits.map((audit) => ({ ...audit }));
      const tx = {
        account: {
          async findFirst(args: unknown) {
            accountQuery = args;
            return ACCOUNT;
          },
        },
        localProductionAccessSession: {
          async create(args: unknown) {
            const input = (args as { data: StoredSession }).data;
            if (transactionSessions.has(input.id)) {
              throw Object.assign(new Error('duplicate session'), { code: 'P2002' });
            }
            transactionSessions.set(input.id, { ...input, revokedAt: null });
            return input;
          },
          async findUnique(args: unknown) {
            const id = (args as { where: { id: string } }).where.id;
            const session = transactionSessions.get(id);
            return session
              ? { ...session, targetAccount: { email: ACCOUNT.email } }
              : null;
          },
          async updateMany(args: unknown) {
            const input = args as {
              where: { id: string; revokedAt: null };
              data: { revokedAt: Date };
            };
            const session = transactionSessions.get(input.where.id);
            if (!session || session.revokedAt) return { count: 0 };
            transactionSessions.set(session.id, { ...session, revokedAt: input.data.revokedAt });
            return { count: 1 };
          },
        },
        localProductionAccessAudit: {
          async create(args: unknown) {
            if (failAudit) throw new Error('audit storage unavailable');
            const input = (args as { data: Record<string, unknown> }).data;
            if (transactionAudits.some(
              (audit) => audit.sessionId === input.sessionId && audit.action === input.action,
            )) {
              throw Object.assign(new Error('duplicate audit action'), { code: 'P2002' });
            }
            transactionAudits.push(input);
            return input;
          },
        },
      };

      const result = await callback(tx);
      sessions = transactionSessions;
      audits = transactionAudits;
      return result;
    },
  };

  const jwt = new JwtService({ secret: SECRET });
  const dependencies = {
    data,
    jwt,
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    randomJti: () => Buffer.alloc(32, 7).toString('base64url'),
  } as unknown as LocalProductionAccessCommandDependencies;

  return {
    dependencies,
    jwt,
    getSessions: () => sessions,
    getAudits: () => audits,
    getAccountQuery: () => accountQuery,
    setAuditFailure: (value: boolean) => { failAudit = value; },
  };
}

const ISSUE_REQUEST = {
  email: ACCOUNT.email,
  reason: 'INC-1234 temporary production diagnosis',
  ttlMinutes: 15,
};

test('CLI issue atomically creates a durable session and separately attributable audit', async () => {
  const fixture = commandFixture();
  const result = await issueLocalProductionAccess(
    ISSUE_REQUEST,
    SSH_PRINCIPAL,
    fixture.dependencies,
  );

  const decoded = fixture.jwt.verify<Record<string, unknown>>(result.accessToken, { secret: SECRET });
  const jti = decoded.jti as string;
  const expectedSessionId = localProductionAccessSessionId(jti);
  assert.equal(result.sessionId, expectedSessionId);
  assert.equal(result.expiresAt, '2026-09-05T12:15:00.000Z');
  assert.equal(decoded.authMethod, 'local_cli');
  assert.equal(decoded.sub, ACCOUNT.id);
  assert.ok(Number(decoded.exp) - Number(decoded.iat) <= 15 * 60);
  assert.deepEqual(fixture.getAccountQuery(), {
    where: { email: ACCOUNT.email, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      sectionId: true,
      adminModules: true,
      bpoPermissions: true,
    },
  });

  const session = fixture.getSessions().get(expectedSessionId);
  assert.equal(session?.targetAccountId, ACCOUNT.id);
  assert.equal(session?.expiresAt.toISOString(), result.expiresAt);
  assert.equal(session?.revokedAt, null);

  const audit = fixture.getAudits()[0];
  assert.equal(audit.action, LocalProductionAccessAuditAction.grant);
  assert.equal(audit.targetAccountId, ACCOUNT.id);
  assert.equal(audit.targetEmail, ACCOUNT.email);
  assert.equal(audit.sessionId, expectedSessionId);
  assert.equal(audit.sshPrincipal, SSH_PRINCIPAL);
  assert.equal(audit.operatorLabel, SSH_PRINCIPAL);
  assert.equal('actorId' in audit, false);

  const persisted = JSON.stringify({ session, audit });
  assert.equal(persisted.includes(jti), false);
  assert.equal(persisted.includes(result.accessToken), false);
  assert.equal(/"(?:accessToken|token|jti)"/.test(persisted), false);
});

test('CLI matches the launcher request contract and requires a server-derived SSH principal', async () => {
  assert.throws(() => validateIssueRequest({
    ...ISSUE_REQUEST,
    ttlMinutes: 16,
  }), /between 1 and 15/);
  assert.throws(() => validateIssueRequest({
    ...ISSUE_REQUEST,
    sshPrincipal: 'forged-in-request',
  }), /exactly/);
  assert.deepEqual(validateIssueRequest({
    email: ACCOUNT.email,
    reason: ISSUE_REQUEST.reason,
    ttlMinutes: 10,
  }), {
    email: ACCOUNT.email,
    reason: ISSUE_REQUEST.reason,
    ttlMinutes: 10,
  });
  assert.deepEqual(validateRevokeRequest({
    reason: 'INC-1234 diagnosis completed',
  }), {
    reason: 'INC-1234 diagnosis completed',
  });
  assert.throws(() => validateSshPrincipal(' user\n'), /exact, trimmed/);

  await assert.rejects(
    () => runLocalProductionAccessCli(['issue'], { NODE_ENV: 'production' }),
    /--confirm-production/,
  );
  await assert.rejects(
    () => runLocalProductionAccessCli(['issue', '--confirm-production'], { NODE_ENV: 'development' }),
    /only available with NODE_ENV=production/,
  );

  const encoded = Buffer.from(JSON.stringify(ISSUE_REQUEST), 'utf8').toString('base64');
  await assert.rejects(
    () => runLocalProductionAccessCli(['issue', '--confirm-production'], {
      NODE_ENV: 'production',
      GUARO_LOCAL_ACCESS_REQUEST_B64: encoded,
      JWT_SECRET: SECRET,
    }),
    /GUARO_LOCAL_ACCESS_SSH_PRINCIPAL/,
  );
});

test('grant audit failure rolls the session back in the same transaction', async () => {
  const fixture = commandFixture();
  fixture.setAuditFailure(true);
  await assert.rejects(
    () => issueLocalProductionAccess(ISSUE_REQUEST, SSH_PRINCIPAL, fixture.dependencies),
    /audit storage unavailable/,
  );
  assert.equal(fixture.getSessions().size, 0);
  assert.equal(fixture.getAudits().length, 0);
});

test('revoke and its audit commit atomically with the target and SSH identities separated', async () => {
  const fixture = commandFixture();
  const issued = await issueLocalProductionAccess(
    { ...ISSUE_REQUEST, ttlMinutes: 5 },
    SSH_PRINCIPAL,
    fixture.dependencies,
  );
  const result = await revokeLocalProductionAccess(
    issued.sessionId,
    { reason: 'INC-1234 diagnosis completed' },
    SSH_PRINCIPAL,
    fixture.dependencies,
  );

  assert.deepEqual(result, { revoked: true, sessionId: issued.sessionId });
  assert.equal(
    fixture.getSessions().get(issued.sessionId)?.revokedAt?.toISOString(),
    '2026-09-05T12:00:00.000Z',
  );
  const audit = fixture.getAudits()[1];
  assert.equal(audit.action, LocalProductionAccessAuditAction.revoke);
  assert.equal(audit.targetAccountId, ACCOUNT.id);
  assert.equal(audit.targetEmail, ACCOUNT.email);
  assert.equal(audit.sshPrincipal, SSH_PRINCIPAL);
  assert.equal(audit.operatorLabel, SSH_PRINCIPAL);
  assert.equal('actorId' in audit, false);
});

test('revoke audit failure rolls the revocation back in the same transaction', async () => {
  const fixture = commandFixture();
  const issued = await issueLocalProductionAccess(
    { ...ISSUE_REQUEST, ttlMinutes: 5 },
    SSH_PRINCIPAL,
    fixture.dependencies,
  );
  fixture.setAuditFailure(true);
  await assert.rejects(
    () => revokeLocalProductionAccess(
      issued.sessionId,
      { reason: 'INC-1234 diagnosis completed' },
      SSH_PRINCIPAL,
      fixture.dependencies,
    ),
    /audit storage unavailable/,
  );
  assert.equal(fixture.getSessions().get(issued.sessionId)?.revokedAt, null);
  assert.equal(fixture.getAudits().length, 1);
});

function localJwtPayload(): JwtPayload {
  return {
    sub: ACCOUNT.id,
    email: 'stale-email@didi-labs.com',
    roles: [AccountRole.user],
    sectionId: null,
    adminModules: [],
    bpoPermissions: [],
    authMethod: 'local_cli',
    jti: Buffer.alloc(32, 3).toString('base64url'),
    exp: Math.floor(Date.now() / 1_000) + 600,
  };
}

test('JwtStrategy validates the durable session and current account roles in one account query', async () => {
  const payload = localJwtPayload();
  let queryCount = 0;
  let query: unknown;
  const prisma = {
    account: {
      async findFirst(args: unknown) {
        queryCount += 1;
        query = args;
        return { ...ACCOUNT, roles: [AccountRole.super_admin] };
      },
    },
  } as unknown as PrismaService;
  const strategy = new JwtStrategy(
    { getOrThrow: () => SECRET } as unknown as ConfigService,
    prisma,
  );
  assert.deepEqual(
    (strategy as unknown as { _verifOpts: { algorithms: string[] } })._verifOpts.algorithms,
    ['HS256'],
  );

  const user = await strategy.validate(payload) as JwtUser;
  assert.equal(queryCount, 1);
  assert.equal(
    (query as { where: { localProductionAccessSessions: { some: { id: string } } } })
      .where.localProductionAccessSessions.some.id,
    localProductionAccessSessionId(payload.jti!),
  );
  assert.deepEqual(user.roles, [AccountRole.super_admin]);
  assert.equal(user.email, ACCOUNT.email);
  assert.equal(user.authMethod, 'local_cli');
  assert.equal(user.jti, payload.jti);
});

test('JwtStrategy fails closed for inactive, malformed or unavailable durable sessions', async () => {
  const payload = localJwtPayload();
  const inactive = new JwtStrategy(
    { getOrThrow: () => SECRET } as unknown as ConfigService,
    { account: { findFirst: async () => null } } as unknown as PrismaService,
  );
  await assert.rejects(() => inactive.validate(payload), UnauthorizedException);

  let malformedQueried = false;
  const malformed = new JwtStrategy(
    { getOrThrow: () => SECRET } as unknown as ConfigService,
    {
      account: {
        findFirst: async () => {
          malformedQueried = true;
          return ACCOUNT;
        },
      },
    } as unknown as PrismaService,
  );
  await assert.rejects(
    () => malformed.validate({ ...payload, jti: 'not-a-valid-jti' }),
    UnauthorizedException,
  );
  assert.equal(malformedQueried, false);

  const unavailable = new JwtStrategy(
    { getOrThrow: () => SECRET } as unknown as ConfigService,
    { account: { findFirst: async () => { throw new Error('database down'); } } } as unknown as PrismaService,
  );
  await assert.rejects(() => unavailable.validate(payload), UnauthorizedException);
});

test('/auth/me never extends local_cli tokens and rejects accounts that no longer exist', async () => {
  let issued = 0;
  let currentAccount: typeof ACCOUNT | null = ACCOUNT;
  const auth = {
    findAccountById: async () => currentAccount,
    issueToken: () => { issued += 1; return 'renewed-token'; },
  };
  const permissions = { permissionsForUser: async () => ['dashboard.view'] };
  const controller = new AuthController(auth as never, permissions as never);
  const baseUser: JwtUser = {
    id: ACCOUNT.id,
    email: ACCOUNT.email,
    roles: ACCOUNT.roles,
    sectionId: null,
    adminModules: [],
    bpoPermissions: [],
  };

  const local = await controller.me({ ...baseUser, authMethod: 'local_cli', jti: 'jti', exp: 1 });
  assert.equal('token' in local, false);
  assert.equal(issued, 0);

  const google = await controller.me(baseUser);
  assert.equal((google as typeof google & { token: string }).token, 'renewed-token');
  assert.equal(issued, 1);

  currentAccount = null;
  await assert.rejects(() => controller.me(baseUser), UnauthorizedException);
});
