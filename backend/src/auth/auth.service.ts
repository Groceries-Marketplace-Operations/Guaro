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

  issueToken(account: Account): string {
    const payload: JwtPayload = {
      sub: account.id,
      email: account.email,
      roles: account.roles,
      sectionId: account.sectionId,
    };
    return this.jwt.sign(payload);
  }
}
