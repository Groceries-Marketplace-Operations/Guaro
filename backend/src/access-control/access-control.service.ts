import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_ALLOWED_ROLES,
  PERMISSION_CATALOG,
  PERMISSION_KEY_SET,
} from './permission-catalog';
import { PermissionAccessService } from './permission-access.service';

const EDITABLE_ROLES: readonly AccountRole[] = [
  AccountRole.user,
  AccountRole.bpo,
  AccountRole.admin,
  AccountRole.director,
];

const ACCESS_AREAS = {
  admin: {
    name: 'Admin',
    visibilityPermissions: [
      'applications.manage', 'sftp_applications.manage', 'bpo.team', 'sections.manage',
      'settings.manage', 'system.manage', 'config.handlers', 'config.webhooks',
      'config.invitations', 'config.users',
    ],
    permissions: [
      'applications.manage', 'applications.create', 'applications.update', 'applications.delete',
      'sftp_applications.manage', 'sftp_applications.update', 'sftp_applications.test',
      'bpo.team', 'sections.view', 'sections.manage', 'settings.manage', 'system.manage',
      'config.handlers', 'config.webhooks', 'config.webhooks.update',
      'config.invitations', 'config.invitations.update',
      'config.users', 'config.users.update', 'config.users.delete',
    ],
  },
  integrations: {
    name: 'Integrations',
    visibilityPermissions: [
      'integrations.forced_open', 'integrations.auto_stores_fetch', 'integrations.auto_menu_fetch',
      'integrations.auto_turn_off', 'integrations.emergencies', 'integrations.promotions_sftp',
      'integrations.custom', 'integrations.promotion_api',
    ],
    permissions: [
      'integrations.forced_open', 'integrations.forced_open.configure', 'integrations.forced_open.execute',
      'integrations.auto_stores_fetch', 'integrations.auto_stores_fetch.configure', 'integrations.auto_stores_fetch.execute',
      'integrations.auto_menu_fetch', 'integrations.auto_menu_fetch.configure', 'integrations.auto_menu_fetch.execute',
      'integrations.auto_turn_off', 'integrations.auto_turn_off.configure', 'integrations.auto_turn_off.execute',
      'integrations.emergencies', 'integrations.emergencies.execute',
      'integrations.promotions_sftp', 'integrations.promotions_sftp.configure', 'integrations.promotions_sftp.execute',
      'integrations.custom', 'integrations.custom.configure', 'integrations.custom.execute',
      'integrations.promotion_api', 'integrations.promotion_api.execute',
    ],
  },
} as const;

type AccessAreaKey = keyof typeof ACCESS_AREAS;

export interface PermissionOverrideInput {
  permission: string;
  allowed: boolean;
}

export interface LayeredPolicyInput {
  permissionOverrides?: PermissionOverrideInput[];
  customSectionAccess?: boolean;
  sectionIds?: string[];
}

@Injectable()
export class AccessControlService {
  constructor(
    private prisma: PrismaService,
    private permissionAccess: PermissionAccessService,
  ) {}

  async matrix() {
    const [sections, sectionRows, permissionRows, profileCounts, userOverrideCount] = await Promise.all([
      this.sections(),
      this.prisma.roleSectionAccess.findMany({ select: { role: true, sectionId: true } }),
      this.prisma.rolePermission.findMany({ select: { role: true, permission: true } }),
      this.prisma.roleSectionProfile.groupBy({ by: ['role'], _count: { _all: true } }),
      this.prisma.accountAccessProfile.count(),
    ]);
    return {
      catalog: PERMISSION_CATALOG,
      sections,
      userOverrideCount,
      roles: [...EDITABLE_ROLES, AccountRole.super_admin].map(role => ({
        role,
        implicitAll: role === AccountRole.super_admin,
        profileCount: profileCounts.find(row => row.role === role)?._count._all ?? 0,
        permissions: role === AccountRole.super_admin
          ? [...ALL_PERMISSION_KEYS]
          : permissionRows.filter(row => row.role === role).map(row => row.permission),
        sectionIds: role === AccountRole.super_admin
          ? sections.map(section => section.id)
          : sectionRows.filter(row => row.role === role).map(row => row.sectionId),
      })),
    };
  }

  async updateRole(role: AccountRole, permissions: string[], sectionIds: string[], actorId: string) {
    this.assertEditableRole(role);
    const uniquePermissions = this.validateBasePermissions(role, permissions);
    const uniqueSectionIds = await this.validateSections(sectionIds);
    const before = await this.baseRoleSnapshot(role);
    const after = { role, permissions: uniquePermissions, sectionIds: uniqueSectionIds };

    await this.prisma.$transaction(async tx => {
      await Promise.all([
        tx.rolePermission.deleteMany({ where: { role } }),
        tx.roleSectionAccess.deleteMany({ where: { role } }),
      ]);
      if (uniquePermissions.length) {
        await tx.rolePermission.createMany({ data: uniquePermissions.map(permission => ({ role, permission })) });
      }
      if (uniqueSectionIds.length) {
        await tx.roleSectionAccess.createMany({ data: uniqueSectionIds.map(sectionId => ({ role, sectionId })) });
      }
      await this.audit(tx, actorId, 'role', role, before, after);
    });
    this.permissionAccess.clearCache();
    return after;
  }

  async roleSectionProfile(role: AccountRole, sectionId: string) {
    this.assertEditableRole(role);
    const section = await this.requireSection(sectionId);
    const [base, profile] = await Promise.all([
      this.baseRoleSnapshot(role),
      this.prisma.roleSectionProfile.findUnique({
        where: { role_sectionId: { role, sectionId } },
        include: {
          permissionOverrides: { select: { permission: true, allowed: true }, orderBy: { permission: 'asc' } },
          sectionScopes: { select: { allowedSectionId: true } },
        },
      }),
    ]);
    const permissionOverrides = profile?.permissionOverrides ?? [];
    const effectivePermissions = this.applyOverrides(base.permissions, permissionOverrides);
    const customSectionAccess = profile?.customSectionAccess ?? false;
    const sectionIds = profile?.sectionScopes.map(scope => scope.allowedSectionId) ?? [];
    return {
      role,
      section,
      basePermissions: base.permissions,
      baseSectionIds: base.sectionIds,
      permissionOverrides,
      customSectionAccess,
      sectionIds,
      effectivePermissions,
      effectiveSectionIds: customSectionAccess ? sectionIds : base.sectionIds,
      updatedAt: profile?.updatedAt ?? null,
    };
  }

  async updateRoleSectionProfile(role: AccountRole, sectionId: string, input: LayeredPolicyInput, actorId: string) {
    this.assertEditableRole(role);
    await this.requireSection(sectionId);
    const permissionOverrides = this.validateOverrides(input.permissionOverrides ?? [], [role]);
    const customSectionAccess = input.customSectionAccess ?? false;
    const sectionIds = await this.validateSections(input.sectionIds ?? []);
    const before = await this.roleSectionProfile(role, sectionId);

    await this.prisma.$transaction(async tx => {
      if (!permissionOverrides.length && !customSectionAccess) {
        await tx.roleSectionProfile.deleteMany({ where: { role, sectionId } });
      } else {
        await tx.roleSectionProfile.upsert({
          where: { role_sectionId: { role, sectionId } },
          create: { role, sectionId, customSectionAccess },
          update: { customSectionAccess },
        });
        await Promise.all([
          tx.roleSectionPermissionOverride.deleteMany({ where: { role, sectionId } }),
          tx.roleSectionScope.deleteMany({ where: { role, profileSectionId: sectionId } }),
        ]);
        if (permissionOverrides.length) {
          await tx.roleSectionPermissionOverride.createMany({
            data: permissionOverrides.map(item => ({ role, sectionId, ...item })),
          });
        }
        if (customSectionAccess && sectionIds.length) {
          await tx.roleSectionScope.createMany({
            data: sectionIds.map(allowedSectionId => ({ role, profileSectionId: sectionId, allowedSectionId })),
          });
        }
      }
      await this.audit(tx, actorId, 'role_section', `${role}:${sectionId}`, before, {
        role, sectionId, permissionOverrides, customSectionAccess, sectionIds: customSectionAccess ? sectionIds : [],
      });
    });
    this.permissionAccess.clearCache();
    return this.roleSectionProfile(role, sectionId);
  }

  async accounts(query = '', page = 1, limit = 25) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where: Prisma.AccountWhereInput = {
      deletedAt: null,
      ...(query.trim() && {
        OR: [
          { name: { contains: query.trim(), mode: 'insensitive' } },
          { email: { contains: query.trim(), mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: {
          id: true, name: true, email: true, roles: true, sectionId: true,
          section: { select: { id: true, name: true } },
          accessProfile: { select: { updatedAt: true } },
          _count: { select: { accessPermissionOverrides: true, accessSectionScopes: true } },
        },
      }),
      this.prisma.account.count({ where }),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  async areaAccess() {
    const [accounts, rolePermissions, sectionOverrides, accountOverrides] = await Promise.all([
      this.prisma.account.findMany({
        where: { deletedAt: null },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        select: {
          id: true, name: true, email: true, roles: true, sectionId: true,
          section: { select: { id: true, name: true } },
        },
      }),
      this.prisma.rolePermission.findMany({ select: { role: true, permission: true } }),
      this.prisma.roleSectionPermissionOverride.findMany({
        select: { role: true, sectionId: true, permission: true, allowed: true },
      }),
      this.prisma.accountPermissionOverride.findMany({
        select: { accountId: true, permission: true, allowed: true },
      }),
    ]);
    const effectiveByAccount = new Map(accounts.map(account => {
      if (account.roles.includes(AccountRole.super_admin)) return [account.id, [...ALL_PERMISSION_KEYS]];
      const roleBase = [...new Set(rolePermissions
        .filter(row => account.roles.includes(row.role))
        .map(row => row.permission))];
      const sectionLayer = account.sectionId
        ? sectionOverrides.filter(row => row.sectionId === account.sectionId && account.roles.includes(row.role))
        : [];
      const inherited = this.applyOverrides(roleBase, sectionLayer);
      const individual = accountOverrides.filter(row => row.accountId === account.id);
      return [account.id, this.applyOverrides(inherited, individual)];
    }));
    const catalogByKey = new Map(PERMISSION_CATALOG.map(item => [item.key, item]));

    return {
      accounts: accounts.map(account => ({
        ...account,
        immutable: account.roles.includes(AccountRole.super_admin),
      })),
      areas: (Object.entries(ACCESS_AREAS) as Array<[AccessAreaKey, typeof ACCESS_AREAS[AccessAreaKey]]>).map(([key, area]) => ({
        key,
        name: area.name,
        permissions: area.permissions.map(permission => ({
          key: permission,
          label: catalogByKey.get(permission)?.label ?? permission,
        })),
        members: accounts.flatMap(account => {
          const effectivePermissions = effectiveByAccount.get(account.id) ?? [];
          const visible = area.visibilityPermissions.some(permission => effectivePermissions.includes(permission));
          const permissions = area.permissions.filter(permission => effectivePermissions.includes(permission));
          return visible ? [{
            account,
            immutable: account.roles.includes(AccountRole.super_admin),
            permissions,
          }] : [];
        }),
      })),
    };
  }

  async updateAreaAccess(areaKey: string, accountId: string, permissions: unknown[], actorId: string) {
    const area = this.requireAccessArea(areaKey);
    if (!Array.isArray(permissions) || permissions.some(permission => typeof permission !== 'string')) {
      throw new BadRequestException('permissions must be an array of strings');
    }
    const desired = [...new Set(permissions as string[])];
    const invalid = desired.filter(permission => !(area.permissions as readonly string[]).includes(permission));
    if (invalid.length) throw new BadRequestException(`Permissions outside ${area.name}: ${invalid.join(', ')}`);
    if (desired.length && !area.visibilityPermissions.some(permission => desired.includes(permission))) {
      throw new BadRequestException(`Select at least one visible ${area.name} module`);
    }

    const profile = await this.accountProfile(accountId);
    if (profile.immutable) {
      throw new BadRequestException('Super Admin has permanent access and cannot be changed');
    }
    const areaPermissions = new Set<string>(area.permissions);
    const inherited = new Set<string>(profile.inheritedPermissions);
    const desiredSet = new Set(desired);
    const retained = profile.permissionOverrides.filter(item => !areaPermissions.has(item.permission));
    const areaOverrides = area.permissions.flatMap(permission => {
      const shouldAllow = desiredSet.has(permission);
      const inheritedAllows = inherited.has(permission);
      return shouldAllow === inheritedAllows ? [] : [{ permission, allowed: shouldAllow }];
    });

    return this.updateAccountProfile(accountId, {
      permissionOverrides: [...retained, ...areaOverrides],
      customSectionAccess: profile.customSectionAccess,
      sectionIds: profile.sectionIds,
    }, actorId);
  }

  async accountProfile(accountId: string) {
    const account = await this.requireAccount(accountId);
    const [rolePermissionRows, sectionOverrideRows, accountOverrides, accountProfile, baseSectionRows, roleProfiles] = await Promise.all([
      this.prisma.rolePermission.findMany({ where: { role: { in: account.roles } }, select: { permission: true } }),
      account.sectionId
        ? this.prisma.roleSectionPermissionOverride.findMany({
          where: { role: { in: account.roles }, sectionId: account.sectionId },
          select: { permission: true, allowed: true },
        })
        : Promise.resolve([]),
      this.prisma.accountPermissionOverride.findMany({
        where: { accountId }, select: { permission: true, allowed: true }, orderBy: { permission: 'asc' },
      }),
      this.prisma.accountAccessProfile.findUnique({ where: { accountId } }),
      this.prisma.roleSectionAccess.findMany({ where: { role: { in: account.roles } }, select: { role: true, sectionId: true } }),
      account.sectionId
        ? this.prisma.roleSectionProfile.findMany({
          where: { role: { in: account.roles }, sectionId: account.sectionId },
          include: { sectionScopes: { select: { allowedSectionId: true } } },
        })
        : Promise.resolve([]),
    ]);

    const roleBase = account.roles.includes(AccountRole.super_admin)
      ? [...ALL_PERMISSION_KEYS]
      : [...new Set(rolePermissionRows.map(row => row.permission))];
    const inheritedPermissions = this.applyOverrides(roleBase, sectionOverrideRows);
    const effectivePermissions = account.roles.includes(AccountRole.super_admin)
      ? [...ALL_PERMISSION_KEYS]
      : this.applyOverrides(inheritedPermissions, accountOverrides);
    const inheritedSectionIds = account.roles.includes(AccountRole.super_admin)
      ? (await this.sections()).map(section => section.id)
      : this.inheritedSections(account.roles, baseSectionRows, roleProfiles);
    const accountSectionIds = await this.prisma.accountSectionScope.findMany({
      where: { accountId }, select: { sectionId: true },
    });
    const customSectionAccess = accountProfile?.customSectionAccess ?? false;
    const sectionIds = accountSectionIds.map(row => row.sectionId);

    return {
      account,
      immutable: account.roles.includes(AccountRole.super_admin),
      inheritedPermissions,
      permissionOverrides: accountOverrides,
      effectivePermissions,
      inheritedSectionIds,
      customSectionAccess,
      sectionIds,
      effectiveSectionIds: customSectionAccess ? sectionIds : inheritedSectionIds,
      updatedAt: accountProfile?.updatedAt ?? null,
    };
  }

  async updateAccountProfile(accountId: string, input: LayeredPolicyInput, actorId: string) {
    const account = await this.requireAccount(accountId);
    if (account.roles.includes(AccountRole.super_admin)) {
      throw new BadRequestException('Super Admin has implicit full access and cannot receive individual overrides');
    }
    const permissionOverrides = this.validateOverrides(input.permissionOverrides ?? [], account.roles);
    const customSectionAccess = input.customSectionAccess ?? false;
    const sectionIds = await this.validateSections(input.sectionIds ?? []);
    const before = await this.accountProfile(accountId);

    await this.prisma.$transaction(async tx => {
      await Promise.all([
        tx.accountPermissionOverride.deleteMany({ where: { accountId } }),
        tx.accountSectionScope.deleteMany({ where: { accountId } }),
      ]);
      if (!permissionOverrides.length && !customSectionAccess) {
        await tx.accountAccessProfile.deleteMany({ where: { accountId } });
      } else {
        await tx.accountAccessProfile.upsert({
          where: { accountId },
          create: { accountId, customSectionAccess },
          update: { customSectionAccess },
        });
        if (permissionOverrides.length) {
          await tx.accountPermissionOverride.createMany({
            data: permissionOverrides.map(item => ({ accountId, ...item })),
          });
        }
        if (customSectionAccess && sectionIds.length) {
          await tx.accountSectionScope.createMany({ data: sectionIds.map(sectionId => ({ accountId, sectionId })) });
        }
      }
      await this.audit(tx, actorId, 'account', accountId, before, {
        accountId, permissionOverrides, customSectionAccess, sectionIds: customSectionAccess ? sectionIds : [],
      });
    });
    this.permissionAccess.clearCache();
    return this.accountProfile(accountId);
  }

  async audits(page = 1, limit = 25) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [data, total] = await Promise.all([
      this.prisma.accessControlAudit.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { actor: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.accessControlAudit.count(),
    ]);
    return { data, total, page: safePage, limit: safeLimit };
  }

  private async baseRoleSnapshot(role: AccountRole) {
    const [permissions, sectionRows] = await Promise.all([
      this.prisma.rolePermission.findMany({ where: { role }, select: { permission: true } }),
      this.prisma.roleSectionAccess.findMany({ where: { role }, select: { sectionId: true } }),
    ]);
    return { role, permissions: permissions.map(row => row.permission), sectionIds: sectionRows.map(row => row.sectionId) };
  }

  private validateBasePermissions(role: AccountRole, permissions: unknown[]) {
    if (!Array.isArray(permissions) || permissions.some(permission => typeof permission !== 'string')) {
      throw new BadRequestException('Every permission must be a string');
    }
    const unique = [...new Set(permissions as string[])];
    const invalid = unique.filter(permission => !PERMISSION_KEY_SET.has(permission));
    if (invalid.length) throw new BadRequestException(`Unknown permissions: ${invalid.join(', ')}`);
    const incompatible = unique.filter(permission => !PERMISSION_ALLOWED_ROLES.get(permission)?.includes(role));
    if (incompatible.length) throw new BadRequestException(`Permissions unavailable for ${role}: ${incompatible.join(', ')}`);
    if (role === AccountRole.admin && !unique.includes('task_types.manage')) {
      unique.push('task_types.manage');
    }
    return unique;
  }

  private validateOverrides(overrides: PermissionOverrideInput[], roles: AccountRole[]) {
    if (!Array.isArray(overrides)) throw new BadRequestException('permissionOverrides must be an array');
    const seen = new Set<string>();
    for (const item of overrides) {
      if (!item || typeof item.permission !== 'string' || typeof item.allowed !== 'boolean') {
        throw new BadRequestException('Every override needs a permission and a boolean allowed value');
      }
      if (seen.has(item.permission)) throw new BadRequestException(`Duplicated permission override: ${item.permission}`);
      seen.add(item.permission);
      if (!PERMISSION_KEY_SET.has(item.permission)) throw new BadRequestException(`Unknown permission: ${item.permission}`);
      if (!roles.some(role => PERMISSION_ALLOWED_ROLES.get(item.permission)?.includes(role))) {
        throw new BadRequestException(`Permission unavailable for this access profile: ${item.permission}`);
      }
      if (roles.includes(AccountRole.admin) && item.permission === 'task_types.manage' && !item.allowed) {
        throw new BadRequestException('Task Types access is required for admin accounts');
      }
    }
    return overrides.map(item => ({ permission: item.permission, allowed: item.allowed }));
  }

  private async validateSections(sectionIds: unknown[]) {
    if (!Array.isArray(sectionIds) || sectionIds.some(sectionId => typeof sectionId !== 'string')) {
      throw new BadRequestException('Every section ID must be a string');
    }
    const unique = [...new Set(sectionIds as string[])];
    const count = await this.prisma.section.count({ where: { id: { in: unique } } });
    if (count !== unique.length) throw new BadRequestException('One or more sections do not exist');
    return unique;
  }

  private applyOverrides(base: string[], overrides: PermissionOverrideInput[]) {
    const effective = new Set(base);
    for (const row of overrides) if (row.allowed) effective.add(row.permission);
    for (const row of overrides) if (!row.allowed) effective.delete(row.permission);
    return [...effective];
  }

  private inheritedSections(
    roles: AccountRole[],
    baseRows: Array<{ role: AccountRole; sectionId: string }>,
    profiles: Array<{ role: AccountRole; customSectionAccess: boolean; sectionScopes: Array<{ allowedSectionId: string }> }>,
  ) {
    const sections = new Set<string>();
    for (const role of roles) {
      const profile = profiles.find(item => item.role === role);
      if (profile?.customSectionAccess) {
        for (const scope of profile.sectionScopes) sections.add(scope.allowedSectionId);
      } else {
        for (const row of baseRows) if (row.role === role) sections.add(row.sectionId);
      }
    }
    return [...sections];
  }

  private assertEditableRole(role: AccountRole) {
    if (!EDITABLE_ROLES.includes(role)) {
      throw new BadRequestException('Super Admin has implicit full access and cannot be restricted');
    }
  }

  private requireAccessArea(value: string) {
    if (!(value in ACCESS_AREAS)) throw new BadRequestException(`Unknown access area: ${value}`);
    return ACCESS_AREAS[value as AccessAreaKey];
  }

  private async requireSection(id: string) {
    const section = await this.prisma.section.findUnique({ where: { id }, select: { id: true, name: true, order: true } });
    if (!section) throw new NotFoundException('Section not found');
    return section;
  }

  private async requireAccount(id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, email: true, roles: true, sectionId: true, section: { select: { id: true, name: true } } },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  private sections() {
    return this.prisma.section.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }], select: { id: true, name: true, order: true } });
  }

  private audit(
    tx: Prisma.TransactionClient,
    actorId: string,
    scopeType: string,
    scopeKey: string,
    before: unknown,
    after: unknown,
  ) {
    return tx.accessControlAudit.create({
      data: {
        actorId,
        scopeType,
        scopeKey,
        before: JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue,
        after: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue,
      },
    });
  }
}
