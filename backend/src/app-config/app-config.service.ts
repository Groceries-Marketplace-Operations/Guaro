import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PatchOptionDto } from './dto/patch-option.dto';
import { UpsertOptionDto } from './dto/upsert-option.dto';

@Injectable()
export class AppConfigService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const options = await this.prisma.appConfigOption.findMany({
      orderBy: [{ category: 'asc' }, { order: 'asc' }, { label: 'asc' }],
    });
    // Group by category
    const grouped: Record<string, typeof options> = {};
    for (const o of options) {
      if (!grouped[o.category]) grouped[o.category] = [];
      grouped[o.category].push(o);
    }
    return grouped;
  }

  async findByCategory(category: string) {
    return this.prisma.appConfigOption.findMany({
      where: { category },
      orderBy: [{ order: 'asc' }, { label: 'asc' }],
    });
  }

  async upsert(dto: UpsertOptionDto) {
    return this.prisma.appConfigOption.upsert({
      where: { category_value: { category: dto.category, value: dto.value } },
      create: { category: dto.category, value: dto.value, label: dto.label, active: dto.active ?? true, order: dto.order ?? 0 },
      update: { label: dto.label, active: dto.active ?? true, order: dto.order ?? 0 },
    });
  }

  async patch(id: string, dto: PatchOptionDto) {
    return this.prisma.appConfigOption.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    return this.prisma.appConfigOption.delete({ where: { id } });
  }
}
