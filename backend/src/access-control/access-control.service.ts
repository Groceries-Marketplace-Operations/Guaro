import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSION_KEYS, PERMISSION_ALLOWED_ROLES, PERMISSION_CATALOG, PERMISSION_KEY_SET } from './permission-catalog';
import { PermissionAccessService } from './permission-access.service';

const EDITABLE_ROLES: readonly AccountRole[] = [
  AccountRole.user,
  AccountRole.bpo,
  AccountRole.admin,
  AccountRole.director,
];

@Injectable()
export class AccessControlService {
  constructor(
    private prisma: PrismaService,
    private permissionAccess: PermissionAccessService,
  ) {}

  async matrix() {
    const [sections, sectionRows, permissionRows] = await Promise.all([
      this.prisma.section.findMany({
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, order: true },
      }),
      this.prisma.roleSectionAccess.findMany({ select: { role: true, sectionId: true } }),
      this.prisma.rolePermission.findMany({ select: { role: true, permission: true } }),
    ]);
    return {
      catalog: PERMISSION_CATALOG,
      sections,
      roles: [...EDITABLE_ROLES, AccountRole.super_admin].map(role => ({
        role,
        implicitAll: role === AccountRole.super_admin,
        permissions: role === AccountRole.super_admin
          ? [...ALL_PERMISSION_KEYS]
          : permissionRows.filter(row => row.role === role).map(row => row.permission),
        sectionIds: role === AccountRole.super_admin
          ? sections.map(section => section.id)
          : sectionRows.filter(row => row.role === role).map(row => row.sectionId),
      })),
    };
  }

  async updateRole(role: AccountRole, permissions: string[], sectionIds: string[]) {
    if (!EDITABLE_ROLES.includes(role)) {
      throw new BadRequestException('Super Admin has implicit full access and cannot be restricted');
    }
    const uniquePermissions = [...new Set(permissions ?? [])];
    if (uniquePermissions.some(permission => typeof permission !== 'string')) {
      throw new BadRequestException('Every permission must be a string');
    }
    const invalidPermissions = uniquePermissions.filter(permission => !PERMISSION_KEY_SET.has(permission));
    if (invalidPermissions.length) throw new BadRequestException(`Unknown permissions: ${invalidPermissions.join(', ')}`);
    const incompatiblePermissions = uniquePermissions.filter(permission => !PERMISSION_ALLOWED_ROLES.get(permission)?.includes(role));
    if (incompatiblePermissions.length) {
      throw new BadRequestException(`Permissions unavailable for ${role}: ${incompatiblePermissions.join(', ')}`);
    }
    const uniqueSectionIds = [...new Set(sectionIds ?? [])];
    if (uniqueSectionIds.some(sectionId => typeof sectionId !== 'string')) {
      throw new BadRequestException('Every section ID must be a string');
    }
    const sectionCount = await this.prisma.section.count({ where: { id: { in: uniqueSectionIds } } });
    if (sectionCount !== uniqueSectionIds.length) throw new BadRequestException('One or more sections do not exist');

    await this.prisma.$transaction(async tx => {
      await Promise.all([
        tx.rolePermission.deleteMany({ where: { role } }),
        tx.roleSectionAccess.deleteMany({ where: { role } }),
      ]);
      if (uniquePermissions.length) {
        await tx.rolePermission.createMany({
          data: uniquePermissions.map(permission => ({ role, permission })),
        });
      }
      if (uniqueSectionIds.length) {
        await tx.roleSectionAccess.createMany({
          data: uniqueSectionIds.map(sectionId => ({ role, sectionId })),
        });
      }
    });
    this.permissionAccess.clearCache();
    return { role, permissions: uniquePermissions, sectionIds: uniqueSectionIds };
  }
}
