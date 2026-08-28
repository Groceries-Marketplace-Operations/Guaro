import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtUser } from '../auth/types/jwt-user.interface';

/**
 * RolesGuard intentionally lets explicit permissions override role metadata.
 * Bind/unbind is sensitive enough to require both the Custom Integrations
 * permission and an administrator role, so this controller has a second guard.
 */
@Injectable()
export class DidiStoreBindingsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: JwtUser }>().user;
    return Boolean(user?.roles?.some(role => role === AccountRole.admin || role === AccountRole.super_admin));
  }
}
