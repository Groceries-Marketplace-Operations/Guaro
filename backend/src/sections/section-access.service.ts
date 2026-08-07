import { Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SectionAccessService {
  constructor(private prisma: PrismaService) {}

  async accessibleSectionIds(roles: AccountRole[]): Promise<string[] | null> {
    if (roles.includes(AccountRole.super_admin)) return null;
    const rows = await this.prisma.roleSectionAccess.findMany({
      where: { role: { in: roles } },
      select: { sectionId: true },
    });
    return [...new Set(rows.map(row => row.sectionId))];
  }

  async canAccess(roles: AccountRole[], sectionId: string): Promise<boolean> {
    const allowed = await this.accessibleSectionIds(roles);
    return allowed === null || allowed.includes(sectionId);
  }
}
