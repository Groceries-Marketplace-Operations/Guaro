import { createHash } from 'node:crypto';

export const LOCAL_PRODUCTION_ACCESS_AUTH_METHOD = 'local_cli' as const;
export const LOCAL_PRODUCTION_ACCESS_MAX_TTL_MINUTES = 15;

const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

export function localProductionAccessSessionId(jti: string): string {
  if (typeof jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jti)) {
    throw new TypeError('Invalid local production access jti');
  }
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

export function assertLocalProductionAccessSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError('sessionId must be a 64-character lowercase SHA-256 hash');
  }
}
