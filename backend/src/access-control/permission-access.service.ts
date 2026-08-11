import { Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSION_KEYS } from './permission-catalog';

type AccessUser = Pick<JwtUser, 'id' | 'roles' | 'sectionId'>;
type OverrideRow = { permission: string; allowed: boolean };

@Injectable()
export class PermissionAccessService {
  private readonly roleCache = new Map<string, { permissions: string[]; expiresAt: number }>();
  private readonly userCache = new Map<string, { permissions: string[]; expiresAt: number }>();

  constructor(private prisma: PrismaService) {}

  async permissionsForRoles(roles: AccountRole[]) {
    if (roles.includes(AccountRole.super_admin)) return [...ALL_PERMISSION_KEYS];
    const cacheKey = [...roles].sort().join('|');
    const cached = this.roleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.permissions];
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { in: roles } },
      select: { permission: true },
    });
    const permissions = this.withMandatoryPermissions(roles, rows.map(row => row.permission));
    this.roleCache.set(cacheKey, { permissions, expiresAt: Date.now() + 30_000 });
    return [...permissions];
  }

  async permissionsForUser(user: AccessUser) {
    if (user.roles.includes(AccountRole.super_admin)) return [...ALL_PERMISSION_KEYS];
    const cacheKey = `${user.id}|${[...user.roles].sort().join('|')}|${user.sectionId ?? '-'}`;
    const cached = this.userCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.permissions];

    const [basePermissions, sectionOverrides, accountOverrides] = await Promise.all([
      this.permissionsForRoles(user.roles),
      user.sectionId
        ? this.prisma.roleSectionPermissionOverride.findMany({
          where: { role: { in: user.roles }, sectionId: user.sectionId },
          select: { permission: true, allowed: true },
        })
        : Promise.resolve([] as OverrideRow[]),
      this.prisma.accountPermissionOverride.findMany({
        where: { accountId: user.id },
        select: { permission: true, allowed: true },
      }),
    ]);

    const effective = new Set(basePermissions);
    this.applyLayer(effective, sectionOverrides);
    this.applyLayer(effective, accountOverrides);
    const permissions = this.withMandatoryPermissions(user.roles, [...effective]);
    this.userCache.set(cacheKey, { permissions, expiresAt: Date.now() + 30_000 });
    return permissions;
  }

  async can(user: AccessUser, required: readonly string[]) {
    if (!required.length || user.roles.includes(AccountRole.super_admin)) return true;
    const permissions = await this.permissionsForUser(user);
    return required.some(permission => permissions.includes(permission));
  }

  clearCache() {
    this.roleCache.clear();
    this.userCache.clear();
  }

  private applyLayer(effective: Set<string>, overrides: OverrideRow[]) {
    for (const row of overrides) if (row.allowed) effective.add(row.permission);
    // If different roles conflict at the same layer, deny wins.
    for (const row of overrides) if (!row.allowed) effective.delete(row.permission);
  }

  private withMandatoryPermissions(roles: AccountRole[], permissions: string[]) {
    const effective = new Set(permissions);
    if (roles.includes(AccountRole.admin)) effective.add('task_types.manage');
    return [...effective];
  }
}
