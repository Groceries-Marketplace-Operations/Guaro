import { SetMetadata } from '@nestjs/common';
import { AccountRol } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: AccountRol[]) => SetMetadata(ROLES_KEY, roles);
