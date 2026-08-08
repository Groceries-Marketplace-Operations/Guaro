import { Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSION_KEYS } from './permission-catalog';

@Injectable()
export class PermissionAccessService {
  private readonly cache = new Map<string, { permissions: string[]; expiresAt: number }>();

  constructor(private prisma: PrismaService) {}

  async permissionsForRoles(roles: AccountRole[]) {
    if (roles.includes(AccountRole.super_admin)) return [...ALL_PERMISSION_KEYS];
    const cacheKey = [...roles].sort().join('|');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.permissions];
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { in: roles } },
      select: { permission: true },
    });
    const permissions = [...new Set(rows.map(row => row.permission))];
    this.cache.set(cacheKey, { permissions, expiresAt: Date.now() + 30_000 });
    return [...permissions];
  }

  async can(roles: AccountRole[], required: readonly string[]) {
    if (!required.length || roles.includes(AccountRole.super_admin)) return true;
    const permissions = await this.permissionsForRoles(roles);
    return required.some(permission => permissions.includes(permission));
  }

  clearCache() {
    this.cache.clear();
  }
}
