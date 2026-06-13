import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

const ALLOWED_DOMAIN = 'didi-labs.com';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private authService: AuthService,
  ) {
    super({
      clientID: config.getOrThrow('GOOGLE_CLIENT_ID'),
      clientSecret: config.getOrThrow('GOOGLE_CLIENT_SECRET'),
      callbackURL: config.getOrThrow('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ) {
    const email: string = profile.emails?.[0]?.value ?? '';

    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return done(new UnauthorizedException('Dominio no permitido'), false);
    }

    const account = await this.authService.findAccountByGoogleProfile(
      profile.id,
      email,
    );

    if (!account) {
      return done(
        new UnauthorizedException(
          'Cuenta no encontrada. Usá el link de invitación para registrarte.',
        ),
        false,
      );
    }

    if (!account.googleSub) {
      await this.authService.linkGoogleSub(account.id, profile.id);
    }

    if (!account.email) {
      await this.authService.linkEmail(account.id, email);
    }

    done(null, account);
  }
}
