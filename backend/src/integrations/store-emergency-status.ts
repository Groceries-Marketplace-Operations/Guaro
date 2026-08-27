import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const STORE_EMERGENCY_LIVE_STATUSES = [
  'pending',
  'running',
  'offline',
  'partial_success',
  'restoring',
] as const;

export const STORE_EMERGENCY_CONFLICT_CODE = 'EMERGENCY_CONFLICT' as const;

export interface StoreEmergencyLiveWhereOptions {
  brandId?: string;
  shopId?: string;
  excludeEmergencyId?: string;
}

export interface StoreEmergencyConflictDetails {
  operation: string;
  emergency: {
    id: string;
    brandId: string;
    mode: string;
    status: string;
    endsAt?: Date | string | null;
  };
  shop?: {
    id: string;
    shopId?: string | null;
  };
  message?: string;
}

export interface StoreEmergencyConflictResponse {
  statusCode: 409;
  error: 'Conflict';
  code: typeof STORE_EMERGENCY_CONFLICT_CODE;
  message: string;
  operation: string;
  blockingEmergency: {
    id: string;
    brandId: string;
    mode: string;
    status: string;
    endsAt: string | null;
  };
  shop?: {
    id: string;
    shopId: string | null;
  };
}

/**
 * Single source of truth for emergencies that still own their target stores.
 * A terminal status never blocks a new shutdown/opening, and finished rows are
 * excluded even if a legacy writer left a live-looking status behind.
 */
export function storeEmergencyLiveWhere(
  options: StoreEmergencyLiveWhereOptions = {},
): Prisma.StoreEmergencyWhereInput {
  const { brandId, shopId, excludeEmergencyId } = options;
  return {
    status: { in: [...STORE_EMERGENCY_LIVE_STATUSES] },
    finishedAt: null,
    ...(brandId ? { brandId } : {}),
    ...(excludeEmergencyId ? { id: { not: excludeEmergencyId } } : {}),
    ...(shopId
      ? {
        OR: [
          { mode: 'all_brand' },
          { mode: 'shop_list', targets: { some: { shopId } } },
        ],
      }
      : {}),
  };
}

export function storeEmergencyConflict(
  details: StoreEmergencyConflictDetails,
): ConflictException {
  const shopLabel = details.shop?.shopId ?? details.shop?.id;
  const message = details.message
    ?? `Cannot ${details.operation}: ${shopLabel ? `store ${shopLabel} is` : 'the store is'} protected by active emergency ${details.emergency.id}`;
  const endsAt = details.emergency.endsAt instanceof Date
    ? details.emergency.endsAt.toISOString()
    : details.emergency.endsAt ?? null;
  const response: StoreEmergencyConflictResponse = {
    statusCode: 409,
    error: 'Conflict',
    code: STORE_EMERGENCY_CONFLICT_CODE,
    message,
    operation: details.operation,
    blockingEmergency: {
      id: details.emergency.id,
      brandId: details.emergency.brandId,
      mode: details.emergency.mode,
      status: details.emergency.status,
      endsAt,
    },
    ...(details.shop
      ? { shop: { id: details.shop.id, shopId: details.shop.shopId ?? null } }
      : {}),
  };
  return new ConflictException(response);
}

export function isEmergencyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === STORE_EMERGENCY_CONFLICT_CODE) return true;
  if ('getResponse' in error && typeof error.getResponse === 'function') {
    const response = error.getResponse();
    return Boolean(
      response
      && typeof response === 'object'
      && 'code' in response
      && response.code === STORE_EMERGENCY_CONFLICT_CODE,
    );
  }
  return false;
}
