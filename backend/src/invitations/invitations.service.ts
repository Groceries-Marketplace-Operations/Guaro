import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UseInvitationDto } from './dto/use-invitation.dto';

@Injectable()
export class InvitationsService {
  constructor(private prisma: PrismaService) {}

  async create(
    creatorId: string,
    creatorRoles: AccountRole[],
    creatorSectionId: string | null,
    dto: CreateInvitationDto,
  ) {
    this.validateCreatorCanInvite(creatorRoles, creatorSectionId, dto);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    return this.prisma.invitation.create({
      data: {
        token,
        rol: dto.role,
        sectionId: dto.sectionId ?? null,
        createdById: creatorId,
        expiresAt,
      },
      select: { id: true, token: true, rol: true, sectionId: true, expiresAt: true },
    });
  }

  async use(token: string, dto: UseInvitationDto) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.usedAt) throw new BadRequestException('Invitation already used');
    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation expired');
    }

    // Email must belong to the allowed domain so Google OAuth can later find the account
    const ALLOWED_DOMAIN = 'didi-labs.com';
    if (!dto.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      throw new BadRequestException(`Email must be a @${ALLOWED_DOMAIN} address`);
    }

    const existing = await this.prisma.account.findFirst({ where: { email: dto.email, deletedAt: null } });
    if (existing) throw new BadRequestException('An account with this email already exists');

    const account = await this.prisma.$transaction(async (tx) => {
      const newAccount = await tx.account.create({
        data: {
          name: dto.name,
          email: dto.email,
          roles: [invitation.rol],
          sectionId: invitation.sectionId ?? null,
        },
      });

      await tx.invitation.update({
        where: { token },
        data: { usedAt: new Date(), accountId: newAccount.id },
      });

      return newAccount;
    });

    return { id: account.id, name: account.name, roles: account.roles };
  }

  async findAll(requesterId: string, requesterRoles: AccountRole[], requesterSectionId: string | null) {
    const where = requesterRoles.includes(AccountRole.super_admin)
      ? {}
      : { createdById: requesterId };

    return this.prisma.invitation.findMany({
      where,
      select: {
        id: true,
        rol: true,
        sectionId: true,
        usedAt: true,
        expiresAt: true,
        createdAt: true,
        account: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async delete(id: string, requesterId: string, requesterRoles: AccountRole[]) {
    const invitation = await this.prisma.invitation.findUnique({ where: { id } });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.usedAt) throw new BadRequestException('Cannot delete a used invitation');

    const isSuperAdmin = requesterRoles.includes(AccountRole.super_admin);
    if (!isSuperAdmin && invitation.createdById !== requesterId) {
      throw new ForbiddenException('You can only delete your own invitations');
    }

    await this.prisma.invitation.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------

  private validateCreatorCanInvite(
    creatorRoles: AccountRole[],
    creatorSectionId: string | null,
    dto: CreateInvitationDto,
  ) {
    const isSuperAdmin = creatorRoles.includes(AccountRole.super_admin);
    const isAdmin = creatorRoles.includes(AccountRole.admin);

    if (!isSuperAdmin && !isAdmin) {
      throw new ForbiddenException('Only admins can create invitations');
    }

    // admin cannot invite admins or super_admins, and only to their own section
    if (isAdmin && !isSuperAdmin) {
      if (
        dto.role === AccountRole.admin ||
        dto.role === AccountRole.super_admin ||
        dto.role === AccountRole.director
      ) {
        throw new ForbiddenException('You do not have permission to assign this role');
      }
      if (dto.sectionId && dto.sectionId !== creatorSectionId) {
        throw new ForbiddenException('You can only invite to your own section');
      }
      // force admin's section if not specified
      dto.sectionId = dto.sectionId ?? creatorSectionId ?? undefined;
    }
  }
}
