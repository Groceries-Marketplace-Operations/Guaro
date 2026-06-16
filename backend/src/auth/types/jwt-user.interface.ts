import { AccountRole } from '@prisma/client';

export interface JwtUser {
  id: string;
  email: string;
  roles: AccountRole[];
  sectionId: string | null;
  bpoPermissions: string[];
}
