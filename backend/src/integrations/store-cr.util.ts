import { ConflictException } from '@nestjs/common';

export const STORE_CR_BLOCKING_STATUSES = ['pending', 'closing', 'closed', 'unknown'];
export const STORE_CR_CONFLICT = 'STORE_CR_AUTO_CLOSURE';

export function operationalDay(country: string, now: Date) {
  // MX (Ciudad de México), CO and CR have fixed offsets for current operations.
  const offset = country === 'CO' ? 5 : 6;
  const local = new Date(now.getTime() - offset * 3600_000);
  let start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4 + offset));
  if (start > now) start = new Date(start.getTime() - 86400_000);
  return { start, end: new Date(start.getTime() + 86400_000) };
}

export function storeCrDecision(completed: number, cancelled: number, unknown: number, threshold: number, minimum: number) {
  const total = completed + cancelled;
  const cr = total ? 100 * completed / total : null;
  return { cr, reason: unknown ? 'incomplete' : total < minimum ? 'insufficient_orders'
    : cr !== null && cr <= threshold + 1e-9 ? 'closure_requested' : 'healthy' };
}

export function closureDestination(base?: string, group?: string) {
  if (!base || !group) return null;
  try {
    const url = new URL(base + group);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function crClosureConflict(blockedUntil: Date) {
  return new ConflictException({ code: STORE_CR_CONFLICT,
    message: 'Auto Open blocked: store was closed for low CR during the current operational day', blockedUntil });
}

export function isCrClosureConflict(error: unknown) {
  return error instanceof ConflictException && (error.getResponse() as { code?: string }).code === STORE_CR_CONFLICT;
}
