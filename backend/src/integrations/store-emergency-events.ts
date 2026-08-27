import { Prisma } from '@prisma/client';

export const STORE_EMERGENCY_EVENT_PHASES = ['lifecycle', 'shutdown', 'schedule', 'restore', 'system'] as const;
export const STORE_EMERGENCY_EVENT_SOURCES = ['user', 'scheduler', 'worker', 'system', 'migration'] as const;
export const STORE_EMERGENCY_EVENT_OUTCOMES = [
  'requested', 'queued', 'running', 'succeeded', 'partial', 'failed', 'rescheduled', 'skipped',
] as const;

export type StoreEmergencyEventPhase = typeof STORE_EMERGENCY_EVENT_PHASES[number];
export type StoreEmergencyEventSource = typeof STORE_EMERGENCY_EVENT_SOURCES[number];
export type StoreEmergencyEventOutcome = typeof STORE_EMERGENCY_EVENT_OUTCOMES[number];

export interface StoreEmergencyEventInput {
  emergencyId: string;
  targetId?: string | null;
  type: string;
  phase: StoreEmergencyEventPhase;
  outcome?: StoreEmergencyEventOutcome | null;
  source: StoreEmergencyEventSource;
  actorId?: string | null;
  attempt?: number | null;
  message?: string | null;
  metadata?: Prisma.InputJsonValue;
  occurredAt?: Date;
}

export interface StoreEmergencyJobData {
  emergencyId: string;
  action: 'offline' | 'restore' | 'reconcile';
  source: 'user' | 'scheduler' | 'system';
  actorId?: string | null;
  retry?: boolean;
}

export function emergencyEventData(input: StoreEmergencyEventInput): Prisma.StoreEmergencyEventUncheckedCreateInput {
  return {
    emergencyId: input.emergencyId,
    targetId: input.targetId ?? null,
    type: input.type,
    phase: input.phase,
    outcome: input.outcome ?? null,
    source: input.source,
    actorId: input.actorId ?? null,
    attempt: input.attempt ?? null,
    message: input.message ? sanitizeEmergencyMessage(input.message) : null,
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
  };
}

export function sanitizeEmergencyMessage(message: string): string {
  return message
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?bearer\s+)[^"'\s,;&)}\]]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|app[_-]?secret|client[_-]?secret|password)["']?\s*[:=]\s*["']?)[^"'\s,;&)}\]]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 8_000);
}
