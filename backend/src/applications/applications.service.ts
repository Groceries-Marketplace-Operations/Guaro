import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Country, Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt } from '../common/crypto.util';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

const SELECT_SAFE = {
  id: true, appId: true, appName: true, country: true, didiBindingEnvironment: true,
  createdById: true, createdAt: true, updatedAt: true, deletedAt: true,
  // appSecret and orderWebhookToken* are intentionally excluded.
};

const ORDER_WEBHOOK_SELECT = {
  id: true,
  appName: true,
  deletedAt: true,
  orderWebhookTokenEncrypted: true,
  orderWebhookTokenHash: true,
  orderWebhookCreatedAt: true,
  orderWebhookRotatedAt: true,
  orderWebhookDisabledAt: true,
} as const;

@Injectable()
export class ApplicationsService {
  private readonly encKey: string;
  private readonly frontendUrl: string;

  constructor(private prisma: PrismaService, config: ConfigService) {
    this.encKey = config.getOrThrow('APP_SECRET_ENCRYPTION_KEY');
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'http://localhost:5173/guaro').replace(/\/+$/, '');
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
          // Restoring a soft-deleted credential is a new authorization
          // boundary: legacy clients must not silently revive PROD access.
          didiBindingEnvironment: dto.didiBindingEnvironment ?? null,
          orderWebhookTokenEncrypted: null,
          orderWebhookTokenHash: null,
          orderWebhookCreatedAt: null,
          orderWebhookRotatedAt: null,
          orderWebhookDisabledAt: null,
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
          didiBindingEnvironment: dto.didiBindingEnvironment ?? null,
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
    if (dto.didiBindingEnvironment !== undefined) {
      data.didiBindingEnvironment = dto.didiBindingEnvironment;
    }
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
      data: {
        deletedAt: new Date(),
        orderWebhookTokenEncrypted: null,
        orderWebhookTokenHash: null,
        orderWebhookCreatedAt: null,
        orderWebhookRotatedAt: null,
        orderWebhookDisabledAt: new Date(),
      },
      select: SELECT_SAFE,
    });
  }

  async getOrderWebhook(id: string) {
    const application = await this.orderWebhookApplication(id);
    return this.orderWebhookResponse(application);
  }

  async createOrderWebhook(id: string) {
    const application = await this.orderWebhookApplication(id);
    if (
      application.orderWebhookTokenEncrypted
      && application.orderWebhookTokenHash
      && !application.orderWebhookDisabledAt
    ) {
      return this.orderWebhookResponse(application);
    }

    // Claim generation atomically. Two simultaneous POSTs must both return the
    // same winning URL; an unconditional update would let the loser return a
    // token that was already invalidated by the winner.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const token = this.newOrderWebhookToken();
      try {
        const claimed = await this.prisma.application.updateMany({
          where: { id, deletedAt: null, orderWebhookTokenHash: null },
          data: {
            orderWebhookTokenEncrypted: encrypt(token, this.encKey),
            orderWebhookTokenHash: this.hashOrderWebhookToken(token),
            orderWebhookCreatedAt: now,
            orderWebhookRotatedAt: null,
            orderWebhookDisabledAt: null,
          },
        });
        const winner = await this.orderWebhookApplication(id);
        if (claimed.count === 1) return this.orderWebhookResponse(winner);
        if (winner.orderWebhookTokenEncrypted && winner.orderWebhookTokenHash) {
          return this.orderWebhookResponse(winner);
        }
      } catch (error) {
        if (!this.isUniqueConstraintError(error) || attempt === 2) throw error;
      }
    }
    throw new InternalServerErrorException('Order webhook could not be generated');
  }

  async rotateOrderWebhook(id: string) {
    const application = await this.orderWebhookApplication(id);
    const now = new Date();
    const token = this.newOrderWebhookToken();
    // Compare-and-swap the token so simultaneous rotations that observed the
    // same URL coalesce instead of returning two URLs where one is already
    // invalid. A later, deliberate rotation still observes the new hash and
    // rotates it normally.
    await this.prisma.application.updateMany({
      where: {
        id,
        deletedAt: null,
        orderWebhookTokenHash: application.orderWebhookTokenHash,
      },
      data: {
        orderWebhookTokenEncrypted: encrypt(token, this.encKey),
        orderWebhookTokenHash: this.hashOrderWebhookToken(token),
        orderWebhookCreatedAt: application.orderWebhookCreatedAt ?? now,
        orderWebhookRotatedAt: now,
        orderWebhookDisabledAt: null,
      },
    });
    return this.orderWebhookResponse(await this.orderWebhookApplication(id));
  }

  async disableOrderWebhook(id: string) {
    await this.orderWebhookApplication(id);
    const updated = await this.prisma.application.update({
      where: { id },
      data: {
        orderWebhookTokenEncrypted: null,
        orderWebhookTokenHash: null,
        orderWebhookDisabledAt: new Date(),
      },
      select: ORDER_WEBHOOK_SELECT,
    });
    return this.orderWebhookResponse(updated);
  }

  private async orderWebhookApplication(id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      select: ORDER_WEBHOOK_SELECT,
    });
    if (!application || application.deletedAt) throw new NotFoundException('Application not found');
    return application;
  }

  private async orderWebhookResponse(
    application: Awaited<ReturnType<ApplicationsService['orderWebhookApplication']>>,
    clearToken?: string,
  ) {
    const [lastReceived, lastAccepted, lastFailed] = await Promise.all([
      this.prisma.didiOrderWebhookEvent.findFirst({
        where: { applicationId: application.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.didiOrderWebhookEvent.findFirst({
        where: { applicationId: application.id, status: 'accepted' },
        orderBy: { acceptedAt: 'desc' },
        select: { acceptedAt: true },
      }),
      this.prisma.didiOrderWebhookEvent.findFirst({
        where: { applicationId: application.id, status: 'failed' },
        orderBy: { failedAt: 'desc' },
        select: { errorMessage: true, remoteErrmsg: true },
      }),
    ]);
    const common = {
      applicationId: application.id,
      appName: application.appName,
      createdAt: application.orderWebhookCreatedAt,
      rotatedAt: application.orderWebhookRotatedAt,
      lastReceivedAt: lastReceived?.createdAt ?? null,
      lastAcceptedAt: lastAccepted?.acceptedAt ?? null,
      lastError: lastFailed?.errorMessage ?? lastFailed?.remoteErrmsg ?? null,
    };

    if (
      application.orderWebhookDisabledAt
      || !application.orderWebhookTokenEncrypted
      || !application.orderWebhookTokenHash
    ) {
      return {
        ...common,
        enabled: false,
        url: null,
      };
    }

    let token = clearToken;
    try {
      token ??= decrypt(application.orderWebhookTokenEncrypted, this.encKey);
    } catch {
      throw new InternalServerErrorException('Order webhook token could not be decrypted');
    }
    const actualHash = this.hashOrderWebhookToken(token);
    const storedHash = application.orderWebhookTokenHash;
    if (
      !/^[a-f0-9]{64}$/.test(storedHash)
      || actualHash.length !== storedHash.length
      || !timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(storedHash, 'hex'))
    ) {
      throw new InternalServerErrorException('Order webhook token integrity check failed');
    }

    return {
      ...common,
      enabled: true,
      url: `${this.frontendUrl}/api/didi-order-webhooks/${token}`,
    };
  }

  private newOrderWebhookToken() {
    return randomBytes(32).toString('base64url');
  }

  private hashOrderWebhookToken(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
