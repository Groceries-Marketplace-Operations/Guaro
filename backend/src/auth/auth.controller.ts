import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './types/jwt-user.interface';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleLogin() {
    // Passport redirects to Google; this method body is never reached.
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: { user: Parameters<AuthService['issueToken']>[0] }, @Res() res: Response) {
    const token = this.authService.issueToken(req.user);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
    res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: JwtUser) {
    const account = await this.authService.findAccountById(user.id);
    if (!account) return user;
    return { id: account.id, name: account.name, email: account.email, roles: account.roles, sectionId: account.sectionId };
  }

  // Only available in development — issues JWT by email without going through Google
  @Post('dev-login')
  async devLogin(@Body('email') email: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    const account = await this.authService.findAccountByGoogleProfile('', email);
    if (!account) throw new ForbiddenException('Account not found');
    return { access_token: this.authService.issueToken(account) };
  }
}
