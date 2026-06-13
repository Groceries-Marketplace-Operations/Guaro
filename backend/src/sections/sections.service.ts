import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SectionsService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.section.findMany({ orderBy: { nombre: 'asc' } });
  }

  async findOne(id: string) {
    const s = await this.prisma.section.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Section no encontrada');
    return s;
  }

  create(nombre: string) {
    return this.prisma.section.create({ data: { nombre } });
  }

  async update(id: string, nombre: string) {
    await this.findOne(id);
    return this.prisma.section.update({ where: { id }, data: { nombre } });
  }
}
