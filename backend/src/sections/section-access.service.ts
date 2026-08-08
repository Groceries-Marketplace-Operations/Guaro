import { Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';

type AccessUser = Pick<JwtUser, 'id' | 'roles' | 'sectionId'>;

@Injectable()
export class SectionAccessService {
  constructor(private prisma: PrismaService) {}

  async accessibleSectionIds(userOrRoles: AccessUser | AccountRole[]): Promise<string[] | null> {
    const legacyRolesOnly = Array.isArray(userOrRoles);
    const roles = legacyRolesOnly ? userOrRoles : userOrRoles.roles;
    if (roles.includes(AccountRole.super_admin)) return null;

    const [baseRows, profiles, accountProfile] = await Promise.all([
      this.prisma.roleSectionAccess.findMany({
        where: { role: { in: roles } },
        select: { role: true, sectionId: true },
      }),
      !legacyRolesOnly && userOrRoles.sectionId
        ? this.prisma.roleSectionProfile.findMany({
          where: { role: { in: roles }, sectionId: userOrRoles.sectionId },
          include: { sectionScopes: { select: { allowedSectionId: true } } },
        })
        : Promise.resolve([] as Array<{
          role: AccountRole;
          customSectionAccess: boolean;
          sectionScopes: Array<{ allowedSectionId: string }>;
        }>),
      !legacyRolesOnly
        ? this.prisma.accountAccessProfile.findUnique({
          where: { accountId: userOrRoles.id },
          include: { account: { select: { accessSectionScopes: { select: { sectionId: true } } } } },
        })
        : Promise.resolve(null),
    ]);

    if (accountProfile?.customSectionAccess) {
      return accountProfile.account.accessSectionScopes.map(scope => scope.sectionId);
    }

    const allowed = new Set<string>();
    for (const role of roles) {
      const profile = profiles.find(item => item.role === role);
      if (profile?.customSectionAccess) {
        for (const scope of profile.sectionScopes) allowed.add(scope.allowedSectionId);
      } else {
        for (const row of baseRows) if (row.role === role) allowed.add(row.sectionId);
      }
    }
    return [...allowed];
  }

  async canAccess(userOrRoles: AccessUser | AccountRole[], sectionId: string): Promise<boolean> {
    const allowed = await this.accessibleSectionIds(userOrRoles);
    return allowed === null || allowed.includes(sectionId);
  }
}
