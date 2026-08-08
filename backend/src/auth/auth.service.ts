import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Account } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async findAccountByGoogleProfile(
    googleSub: string,
    email: string,
  ): Promise<Account | null> {
    return this.prisma.account.findFirst({
      where: {
        OR: [{ googleSub }, { email }],
        deletedAt: null,
      },
    });
  }

  async linkGoogleSub(accountId: string, googleSub: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { googleSub },
    });
  }

  async linkEmail(accountId: string, email: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { email },
    });
  }

  findAccountById(id: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { id, deletedAt: null } });
  }

  listDevAccounts() {
    return this.prisma.account.findMany({
      where: { deletedAt: null },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        roles: true,
        sectionId: true,
        adminModules: true,
        bpoPermissions: true,
        section: { select: { name: true } },
      },
    });
  }

  issueToken(account: Account): string {
    const payload: JwtPayload = {
      sub: account.id,
      email: account.email,
      roles: account.roles,
      sectionId: account.sectionId,
      adminModules: account.adminModules,
      bpoPermissions: account.bpoPermissions,
    };
    return this.jwt.sign(payload);
  }
}
