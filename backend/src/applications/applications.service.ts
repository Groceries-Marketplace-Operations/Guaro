import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async create(dto: CreateApplicationDto, createdById: string) {
    const appId = dto.appId.trim();
    const existing = await this.prisma.application.findUnique({ where: { appId } });

    if (existing && !existing.deletedAt) {
      throw new ConflictException('An application with this App ID already exists');
    }

    if (existing) {
      await this.assertCountryCanChange(existing.id, dto.country);
      return this.prisma.application.update({
        where: { id: existing.id },
        data: {
          appName: dto.appName.trim(),
          country: dto.country,
          appSecret: encrypt(dto.appSecret, this.encKey),
          createdById,
          deletedAt: null,
        },
        select: SELECT_SAFE,
      });
    }

    try {
      return await this.prisma.application.create({
        data: {
          appId,
          appName: dto.appName.trim(),
          country: dto.country,
          appSecret: encrypt(dto.appSecret, this.encKey),
          createdById,
        },
        select: SELECT_SAFE,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An application with this App ID already exists');
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateApplicationDto) {
    const application = await this.findOne(id);
    if (dto.country && dto.country !== application.country) {
      await this.assertCountryCanChange(id, dto.country);
    }
    const data: Record<string, unknown> = {};
    if (dto.appName) data.appName = dto.appName.trim();
    if (dto.appSecret) data.appSecret = encrypt(dto.appSecret, this.encKey);
    if (dto.country) data.country = dto.country;
    return this.prisma.application.update({ where: { id }, data, select: SELECT_SAFE });
  }

  private async assertCountryCanChange(id: string, country: Country) {
    const conflictingBrand = await this.prisma.brand.findFirst({
      where: { applicationId: id, country: { not: country } },
      select: { brandName: true, country: true },
      orderBy: { brandName: 'asc' },
    });
    if (conflictingBrand) {
      throw new ConflictException(
        `Country cannot be changed while the application is linked to ${conflictingBrand.brandName} (${conflictingBrand.country})`,
      );
    }
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
