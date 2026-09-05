import { JwtService } from '@nestjs/jwt';
import {
  AccountRole,
  LocalProductionAccessAuditAction,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  assertLocalProductionAccessSessionId,
  LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
  LOCAL_PRODUCTION_ACCESS_MAX_TTL_MINUTES,
  localProductionAccessSessionId,
} from './local-production-access-session';

const REQUEST_ENV_NAME = 'GUARO_LOCAL_ACCESS_REQUEST_B64';
const SSH_PRINCIPAL_ENV_NAME = 'GUARO_LOCAL_ACCESS_SSH_PRINCIPAL';
const CONFIRM_PRODUCTION_FLAG = '--confirm-production';

interface LocalAccessAccount {
  id: string;
  name: string;
  email: string;
  roles: AccountRole[];
  sectionId: string | null;
  adminModules: string[];
  bpoPermissions: string[];
}

interface LocalAccessSession {
  id: string;
  targetAccountId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  targetAccount: { email: string };
}

interface LocalAccessTransactionClient {
  account: {
    findFirst(args: unknown): Promise<LocalAccessAccount | null>;
  };
  localProductionAccessSession: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<LocalAccessSession | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  localProductionAccessAudit: {
    create(args: unknown): Promise<unknown>;
  };
}

interface LocalAccessDataClient {
  $transaction<T>(callback: (tx: LocalAccessTransactionClient) => Promise<T>): Promise<T>;
}

interface LocalAccessJwtSigner {
  sign(
    payload: Record<string, unknown>,
    options: { algorithm: 'HS256'; expiresIn: number; jwtid: string },
  ): string;
}

export interface LocalProductionAccessIssueRequest {
  email: string;
  reason: string;
  ttlMinutes: number;
}

export interface LocalProductionAccessRevokeRequest {
  reason: string;
}

export interface LocalProductionAccessIssueResult {
  accessToken: string;
  sessionId: string;
  expiresAt: string;
}

export interface LocalProductionAccessRevokeResult {
  revoked: boolean;
  sessionId: string;
}

export interface LocalProductionAccessCommandDependencies {
  data: LocalAccessDataClient;
  jwt: LocalAccessJwtSigner;
  now?: () => Date;
  randomJti?: () => string;
}

function exactString(
  value: unknown,
  name: string,
  { min, max }: { min: number; max: number },
): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max) {
    throw new TypeError(`${name} must be an exact, trimmed string between ${min} and ${max} characters`);
  }
  return value;
}

function requireExactFields(raw: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(raw).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`request must contain exactly: ${allowed.join(', ')}`);
  }
}

export function validateSshPrincipal(value: string | undefined): string {
  const principal = exactString(value, SSH_PRINCIPAL_ENV_NAME, { min: 3, max: 200 });
  if (/\p{Cc}/u.test(principal)) {
    throw new TypeError(`${SSH_PRINCIPAL_ENV_NAME} must not contain control characters`);
  }
  return principal;
}

export function parseLocalProductionAccessRequest(encoded: string | undefined): Record<string, unknown> {
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError(`${REQUEST_ENV_NAME} must contain valid base64 JSON`);
  }
  try {
    const bytes = Buffer.from(encoded, 'base64');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new TypeError(`${REQUEST_ENV_NAME} must contain valid base64 JSON`);
  }
}

export function validateIssueRequest(raw: Record<string, unknown>): LocalProductionAccessIssueRequest {
  requireExactFields(raw, ['email', 'reason', 'ttlMinutes']);
  const email = exactString(raw.email, 'email', { min: 3, max: 320 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError('email must be valid');
  const reason = exactString(raw.reason, 'reason', { min: 10, max: 500 });
  if (!Number.isInteger(raw.ttlMinutes) || Number(raw.ttlMinutes) < 1 || Number(raw.ttlMinutes) > LOCAL_PRODUCTION_ACCESS_MAX_TTL_MINUTES) {
    throw new TypeError(`ttlMinutes must be an integer between 1 and ${LOCAL_PRODUCTION_ACCESS_MAX_TTL_MINUTES}`);
  }
  return { email, reason, ttlMinutes: Number(raw.ttlMinutes) };
}

export function validateRevokeRequest(raw: Record<string, unknown>): LocalProductionAccessRevokeRequest {
  requireExactFields(raw, ['reason']);
  return {
    reason: exactString(raw.reason, 'reason', { min: 10, max: 500 }),
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function commandNow(dependencies: LocalProductionAccessCommandDependencies): Date {
  const now = (dependencies.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Server time is unavailable');
  }
  return now;
}

export async function issueLocalProductionAccess(
  request: LocalProductionAccessIssueRequest,
  sshPrincipal: string,
  dependencies: LocalProductionAccessCommandDependencies,
): Promise<LocalProductionAccessIssueResult> {
  const input = validateIssueRequest(request as unknown as Record<string, unknown>);
  const authenticatedSshPrincipal = validateSshPrincipal(sshPrincipal);
  const now = commandNow(dependencies);
  const ttlSeconds = input.ttlMinutes * 60;
  const expiresAtDate = new Date(now.getTime() + ttlSeconds * 1_000);
  const expiresAt = expiresAtDate.toISOString();
  const randomJti = dependencies.randomJti ?? (() => randomBytes(32).toString('base64url'));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const jti = randomJti();
    const sessionId = localProductionAccessSessionId(jti);
    try {
      return await dependencies.data.$transaction(async (tx) => {
        const account = await tx.account.findFirst({
          where: { email: input.email, deletedAt: null },
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
        if (!account || account.email !== input.email) {
          throw new Error('The exact production account was not found or is inactive');
        }

        const accessToken = dependencies.jwt.sign({
          sub: account.id,
          email: account.email,
          roles: account.roles,
          sectionId: account.sectionId,
          adminModules: account.adminModules,
          bpoPermissions: account.bpoPermissions,
          authMethod: LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
        }, {
          algorithm: 'HS256',
          expiresIn: ttlSeconds,
          jwtid: jti,
        });

        await tx.localProductionAccessSession.create({
          data: {
            id: sessionId,
            targetAccountId: account.id,
            expiresAt: expiresAtDate,
            createdAt: now,
          },
        });
        await tx.localProductionAccessAudit.create({
          data: {
            targetAccountId: account.id,
            targetEmail: account.email,
            sessionId,
            action: LocalProductionAccessAuditAction.grant,
            sshPrincipal: authenticatedSshPrincipal,
            operatorLabel: authenticatedSshPrincipal,
            reason: input.reason,
            createdAt: now,
            detail: {
              schemaVersion: 1,
              authMethod: LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
              issuedAt: now.toISOString(),
              expiresAt,
              ttlMinutes: input.ttlMinutes,
            } as Prisma.InputJsonValue,
          },
        });

        return { accessToken, sessionId, expiresAt };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) continue;
      throw error;
    }
  }
  throw new Error('Could not allocate a unique local access session');
}

export async function revokeLocalProductionAccess(
  sessionId: string,
  request: LocalProductionAccessRevokeRequest,
  sshPrincipal: string,
  dependencies: LocalProductionAccessCommandDependencies,
): Promise<LocalProductionAccessRevokeResult> {
  assertLocalProductionAccessSessionId(sessionId);
  const input = validateRevokeRequest(request as unknown as Record<string, unknown>);
  const authenticatedSshPrincipal = validateSshPrincipal(sshPrincipal);
  const revokedAt = commandNow(dependencies);

  return dependencies.data.$transaction(async (tx) => {
    const session = await tx.localProductionAccessSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        targetAccountId: true,
        expiresAt: true,
        revokedAt: true,
        targetAccount: { select: { email: true } },
      },
    });
    if (!session || session.revokedAt) return { revoked: false, sessionId };

    const update = await tx.localProductionAccessSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt },
    });
    if (update.count !== 1) return { revoked: false, sessionId };

    await tx.localProductionAccessAudit.create({
      data: {
        targetAccountId: session.targetAccountId,
        targetEmail: session.targetAccount.email,
        sessionId,
        action: LocalProductionAccessAuditAction.revoke,
        sshPrincipal: authenticatedSshPrincipal,
        operatorLabel: authenticatedSshPrincipal,
        reason: input.reason,
        createdAt: revokedAt,
        detail: {
          schemaVersion: 1,
          authMethod: LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
          revokedAt: revokedAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          expiredBeforeRevocation: session.expiresAt.getTime() <= revokedAt.getTime(),
        } as Prisma.InputJsonValue,
      },
    });
    return { revoked: true, sessionId };
  });
}

export async function runLocalProductionAccessCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<LocalProductionAccessIssueResult | LocalProductionAccessRevokeResult> {
  if (env.NODE_ENV !== 'production') throw new Error('This command is only available with NODE_ENV=production');
  if (!argv.includes(CONFIRM_PRODUCTION_FLAG)) {
    throw new Error(`Explicit ${CONFIRM_PRODUCTION_FLAG} is required`);
  }
  const command = argv[0];
  if (command !== 'issue' && command !== 'revoke') throw new Error('Expected command: issue or revoke');
  const rawRequest = parseLocalProductionAccessRequest(env[REQUEST_ENV_NAME]);
  const sshPrincipal = validateSshPrincipal(env[SSH_PRINCIPAL_ENV_NAME]);
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET is unavailable or too short');

  const prisma = new PrismaClient();
  const dependencies: LocalProductionAccessCommandDependencies = {
    data: prisma as unknown as LocalAccessDataClient,
    jwt: new JwtService({ secret: jwtSecret }) as unknown as LocalAccessJwtSigner,
  };

  try {
    await prisma.$connect();
    if (command === 'issue') {
      return await issueLocalProductionAccess(
        validateIssueRequest(rawRequest),
        sshPrincipal,
        dependencies,
      );
    }
    const sessionId = argv[1];
    if (!sessionId || sessionId.startsWith('--')) throw new Error('revoke requires sessionId');
    return await revokeLocalProductionAccess(
      sessionId,
      validateRevokeRequest(rawRequest),
      sshPrincipal,
      dependencies,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runLocalProductionAccessCli(process.argv.slice(2), process.env)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown failure';
      process.stderr.write(`Local production access command failed: ${message}\n`);
      process.exitCode = 1;
    });
}
