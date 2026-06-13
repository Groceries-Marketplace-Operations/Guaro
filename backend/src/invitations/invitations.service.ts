import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UseInvitationDto } from './dto/use-invitation.dto';

@Injectable()
export class InvitationsService {
  constructor(private prisma: PrismaService) {}

  async create(
    creatorId: string,
    creatorRoles: AccountRol[],
    creatorSectionId: string | null,
    dto: CreateInvitationDto,
  ) {
    this.validateCreatorCanInvite(creatorRoles, creatorSectionId, dto);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

    return this.prisma.invitation.create({
      data: {
        token,
        rol: dto.rol,
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

    if (!invitation) throw new NotFoundException('Invitación no encontrada');
    if (invitation.usedAt) throw new BadRequestException('Invitación ya usada');
    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitación expirada');
    }

    const account = await this.prisma.$transaction(async (tx) => {
      const newAccount = await tx.account.create({
        data: {
          nombre: dto.nombre,
          email: '',        // se completará en el primer login con Google
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

    return { id: account.id, nombre: account.nombre, roles: account.roles };
  }

  async findAll(requesterId: string, requesterRoles: AccountRol[], requesterSectionId: string | null) {
    const where = requesterRoles.includes(AccountRol.super_admin)
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
        account: { select: { id: true, nombre: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // -------------------------------------------------------------------------

  private validateCreatorCanInvite(
    creatorRoles: AccountRol[],
    creatorSectionId: string | null,
    dto: CreateInvitationDto,
  ) {
    const isSuperAdmin = creatorRoles.includes(AccountRol.super_admin);
    const isAdmin = creatorRoles.includes(AccountRol.admin);

    if (!isSuperAdmin && !isAdmin) {
      throw new ForbiddenException('Solo admins pueden crear invitaciones');
    }

    // admin no puede invitar a admins ni super_admins, y solo a su section
    if (isAdmin && !isSuperAdmin) {
      if (
        dto.rol === AccountRol.admin ||
        dto.rol === AccountRol.super_admin ||
        dto.rol === AccountRol.director
      ) {
        throw new ForbiddenException('No tenés permisos para asignar este rol');
      }
      if (dto.sectionId && dto.sectionId !== creatorSectionId) {
        throw new ForbiddenException('Solo podés invitar a tu propia section');
      }
      // fuerza la section del admin si no se especificó
      dto.sectionId = dto.sectionId ?? creatorSectionId ?? undefined;
    }
  }
}
