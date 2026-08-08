import {
  ArgumentsHost, Body, Catch, Controller, ExceptionFilter,
  ForbiddenException, Get, HttpException, Post, Req, Res, UseFilters, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './types/jwt-user.interface';
import { PermissionAccessService } from '../access-control/permission-access.service';

@Catch(HttpException)
class OAuthFailureFilter implements ExceptionFilter {
  catch(_: HttpException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
    res.redirect(`${frontendUrl}/auth/error?reason=not_invited`);
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private permissionAccess: PermissionAccessService,
  ) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleLogin() {
    // Passport redirects to Google; this method body is never reached.
  }

  @Get('google/callback')
  @UseFilters(OAuthFailureFilter)
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
    // Re-issue JWT so role/permission changes take effect without requiring logout
    const token = this.authService.issueToken(account);
    const permissions = await this.permissionAccess.permissionsForUser(account);
    return { id: account.id, name: account.name, email: account.email, roles: account.roles, sectionId: account.sectionId, adminModules: account.adminModules, bpoPermissions: account.bpoPermissions, permissions, token };
  }

  // Only available in development — issues JWT by email without going through Google
  @Get('dev-accounts')
  async devAccounts() {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    const accounts = await this.authService.listDevAccounts();
    return Promise.all(accounts.map(async account => ({
      ...account,
      sectionName: account.section?.name ?? null,
      section: undefined,
      permissions: await this.permissionAccess.permissionsForUser(account),
    })));
  }

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
