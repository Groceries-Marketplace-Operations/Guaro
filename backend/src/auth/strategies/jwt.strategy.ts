import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AccountRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
  localProductionAccessSessionId,
} from '../local-production-access-session';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: AccountRole[];
  sectionId: string | null;
  adminModules: string[];
  bpoPermissions: string[];
  authMethod?: typeof LOCAL_PRODUCTION_ACCESS_AUTH_METHOD;
  jti?: string;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKey: config.getOrThrow('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.authMethod === LOCAL_PRODUCTION_ACCESS_AUTH_METHOD) {
      return this.validateLocalProductionAccess(payload);
    }
    return {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      sectionId: payload.sectionId,
      adminModules: payload.adminModules ?? [],
      bpoPermissions: payload.bpoPermissions ?? [],
    };
  }

  private async validateLocalProductionAccess(payload: JwtPayload) {
    if (!payload.jti || !Number.isInteger(payload.exp)) {
      throw new UnauthorizedException('Local production access session is invalid');
    }

    let sessionId: string;
    try {
      sessionId = localProductionAccessSessionId(payload.jti);
    } catch {
      throw new UnauthorizedException('Local production access session is invalid');
    }

    const now = new Date();
    let account;
    try {
      account = await this.prisma.account.findFirst({
        where: {
          id: payload.sub,
          deletedAt: null,
          localProductionAccessSessions: {
            some: {
              id: sessionId,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          },
        },
        select: {
          id: true,
          email: true,
          roles: true,
          sectionId: true,
          adminModules: true,
          bpoPermissions: true,
        },
      });
    } catch {
      throw new UnauthorizedException('Local production access session is unavailable');
    }
    if (!account) throw new UnauthorizedException('Local production access session is inactive');

    return {
      id: account.id,
      email: account.email,
      roles: account.roles,
      sectionId: account.sectionId,
      adminModules: account.adminModules,
      bpoPermissions: account.bpoPermissions,
      authMethod: LOCAL_PRODUCTION_ACCESS_AUTH_METHOD,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
