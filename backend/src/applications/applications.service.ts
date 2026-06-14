import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Country, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt } from '../common/crypto.util';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

const SELECT_SAFE = {
  id: true, appId: true, appName: true, country: true,
  createdById: true, createdAt: true, updatedAt: true, deletedAt: true,
  // appSecret excluido intencionalmente
};

@Injectable()
export class ApplicationsService {
  private readonly encKey: string;

  constructor(private prisma: PrismaService, config: ConfigService) {
    this.encKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
  }

  async findAll(filters: { page?: number; limit?: number; q?: string; country?: Country } = {}) {
    const { page = 1, limit = 25, q, country } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.ApplicationWhereInput = { deletedAt: null };
    if (country) where.country = country;
    if (q) where.OR = [
      { appName: { contains: q, mode: 'insensitive' } },
      { appId:   { contains: q, mode: 'insensitive' } },
    ];

    const [data, total] = await Promise.all([
      this.prisma.application.findMany({ where, select: SELECT_SAFE, orderBy: { appName: 'asc' }, skip, take: limit }),
      this.prisma.application.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const app = await this.prisma.application.findUnique({ where: { id }, select: SELECT_SAFE });
    if (!app || app.deletedAt) throw new NotFoundException('Application not found');
    return app;
  }

  create(dto: CreateApplicationDto, createdById: string) {
    return this.prisma.application.create({
      data: {
        appId: dto.appId,
        appName: dto.appName,
        country: dto.country,
        appSecret: encrypt(dto.appSecret, this.encKey),
        createdById,
      },
      select: SELECT_SAFE,
    });
  }

  async update(id: string, dto: UpdateApplicationDto) {
    await this.findOne(id);
    const data: Record<string, unknown> = {};
    if (dto.appName) data.appName = dto.appName;
    if (dto.appSecret) data.appSecret = encrypt(dto.appSecret, this.encKey);
    return this.prisma.application.update({ where: { id }, data, select: SELECT_SAFE });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.application.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: SELECT_SAFE,
    });
  }
}
