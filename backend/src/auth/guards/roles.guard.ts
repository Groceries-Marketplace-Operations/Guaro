import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PermissionAccessService } from '../../access-control/permission-access.service';
import { PERMISSIONS_KEY } from '../../access-control/permissions.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionAccess: PermissionAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();
    const permissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    // An explicit permission is authoritative. This lets a user receive one
    // specific capability without having to promote the account to Admin.
    if (permissions.length) return this.permissionAccess.can(user, permissions);

    const required = this.reflector.getAllAndOverride<AccountRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return !required?.length || required.some((role) => user?.roles?.includes(role));
  }
}
