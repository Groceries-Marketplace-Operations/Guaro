import type { Account } from '../types';

export function hasPermission(account: Account | null, permission: string) {
  return Boolean(account?.roles.includes('super_admin') || account?.permissions?.includes(permission));
}

export function hasAnyPermission(account: Account | null, permissions: readonly string[]) {
  return permissions.some(permission => hasPermission(account, permission));
}
