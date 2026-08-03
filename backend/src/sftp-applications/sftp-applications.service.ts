import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { encrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSftpApplicationDto } from './dto/create-sftp-application.dto';
import { UpdateSftpApplicationDto } from './dto/update-sftp-application.dto';

const SAFE_SELECT = {
  id: true,
  name: true,
  host: true,
  port: true,
  username: true,
  rootPath: true,
  active: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class SftpApplicationsService {
  private readonly encryptionKey: string;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.encryptionKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
  }

  async list(params: { page?: number; limit?: number; q?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));
    const where: Prisma.SftpApplicationWhereInput = {
      deletedAt: null,
      ...(params.q ? {
        OR: [
          { name: { contains: params.q, mode: 'insensitive' } },
          { host: { contains: params.q, mode: 'insensitive' } },
          { username: { contains: params.q, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.sftpApplication.findMany({
        where,
        select: SAFE_SELECT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.sftpApplication.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async create(dto: CreateSftpApplicationDto, createdById: string) {
    return this.prisma.sftpApplication.create({
      data: {
        ...dto,
        password: encrypt(dto.password, this.encryptionKey),
        rootPath: dto.rootPath?.trim() || null,
        createdById,
      },
      select: SAFE_SELECT,
    });
  }

  async update(id: string, dto: UpdateSftpApplicationDto) {
    await this.findOne(id);
    return this.prisma.sftpApplication.update({
      where: { id },
      data: {
        name: dto.name,
        host: dto.host,
        port: dto.port,
        username: dto.username,
        password: dto.password ? encrypt(dto.password, this.encryptionKey) : undefined,
        rootPath: dto.rootPath === undefined ? undefined : dto.rootPath.trim() || null,
        active: dto.active,
      },
      select: SAFE_SELECT,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.sftpApplication.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
      select: SAFE_SELECT,
    });
  }

  private async findOne(id: string) {
    const application = await this.prisma.sftpApplication.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });
    if (!application || application.deletedAt) throw new NotFoundException('SFTP application not found');
    return application;
  }
}
