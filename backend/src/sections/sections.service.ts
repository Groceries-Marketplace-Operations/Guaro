import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SectionAccessService } from './section-access.service';
import { JwtUser } from '../auth/types/jwt-user.interface';

const EDITABLE_ROLES: readonly AccountRole[] = [AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.director];

@Injectable()
export class SectionsService {
  constructor(private prisma: PrismaService, private access: SectionAccessService) {}

  async findAll(user: JwtUser) {
    const allowed = await this.access.accessibleSectionIds(user);
    const where = allowed === null ? {} : { id: { in: allowed } };

    return this.prisma.section.findMany({
      where,
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { taskTypes: true, accounts: true } } },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.section.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Section not found');
    return s;
  }

  async create(name: string) {
    const aggregate = await this.prisma.section.aggregate({ _max: { order: true } });
    return this.prisma.section.create({
      data: {
        name,
        order: (aggregate._max.order ?? -1) + 1,
        roleAccesses: { create: EDITABLE_ROLES.map(role => ({ role })) },
      },
    });
  }

  async update(id: string, name: string) {
    await this.findOne(id);
    return this.prisma.section.update({ where: { id }, data: { name } });
  }

  async reorder(order: { id: string; order: number }[]) {
    const uniqueIds = [...new Set(order.map(item => item.id))];
    if (uniqueIds.length !== order.length || order.some(item => !Number.isInteger(item.order) || item.order < 0)) {
      throw new BadRequestException('Section order must contain unique IDs and non-negative integer positions');
    }
    const count = await this.prisma.section.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) throw new BadRequestException('One or more sections do not exist');
    await this.prisma.$transaction(order.map(item => this.prisma.section.update({ where: { id: item.id }, data: { order: item.order } })));
    return { updated: order.length };
  }

  async getRoleAccess() {
    const [sections, rows] = await Promise.all([
      this.prisma.section.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }], select: { id: true, name: true, order: true } }),
      this.prisma.roleSectionAccess.findMany({ select: { role: true, sectionId: true } }),
    ]);
    return {
      sections,
      roles: [...EDITABLE_ROLES, AccountRole.super_admin].map(role => ({
        role,
        implicitAll: role === AccountRole.super_admin,
        sectionIds: role === AccountRole.super_admin
          ? sections.map(section => section.id)
          : rows.filter(row => row.role === role).map(row => row.sectionId),
      })),
    };
  }

  async updateRoleAccess(role: AccountRole, sectionIds: string[]) {
    if (!EDITABLE_ROLES.includes(role)) throw new BadRequestException('This role has implicit access and cannot be edited');
    const uniqueIds = [...new Set(sectionIds ?? [])];
    const count = await this.prisma.section.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) throw new BadRequestException('One or more sections do not exist');
    await this.prisma.$transaction(async tx => {
      await tx.roleSectionAccess.deleteMany({ where: { role } });
      if (uniqueIds.length) {
        await tx.roleSectionAccess.createMany({ data: uniqueIds.map(sectionId => ({ role, sectionId })) });
      }
    });
    return { role, sectionIds: uniqueIds };
  }
}
