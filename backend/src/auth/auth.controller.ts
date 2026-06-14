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
    // In production, redirect to frontend with token as query param or cookie.
    res.json({ access_token: token });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtUser) {
    return user;
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
