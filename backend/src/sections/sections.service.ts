import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SectionsService {
  constructor(private prisma: PrismaService) {}

  findAll(roles: AccountRole[], sectionId: string | null) {
    const isAdmin = roles.includes(AccountRole.admin) && !roles.includes(AccountRole.super_admin);
    const where = isAdmin && sectionId ? { id: sectionId } : {};

    return this.prisma.section.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { taskTypes: true, accounts: true } } },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.section.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Section not found');
    return s;
  }

  create(name: string) {
    return this.prisma.section.create({ data: { name } });
  }

  async update(id: string, name: string) {
    await this.findOne(id);
    return this.prisma.section.update({ where: { id }, data: { name } });
  }
}
