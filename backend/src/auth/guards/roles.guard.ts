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
    const required = this.reflector.getAllAndOverride<AccountRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const { user } = context.switchToHttp().getRequest();
    if (required?.length && !required.some((role) => user?.roles?.includes(role))) return false;

    const permissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    return this.permissionAccess.can(user, permissions);
  }
}
