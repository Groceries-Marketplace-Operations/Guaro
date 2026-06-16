import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountRole, Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async list(
    @CurrentUser() requester: JwtUser,
    @Query('role') role?: AccountRole,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);

    const where: Prisma.AccountWhereInput = { deletedAt: null };

    if (!isSuperAdmin) {
      where.sectionId = requester.sectionId ?? undefined;
      where.roles = { hasSome: [AccountRole.user, AccountRole.bpo] };
    } else if (role) {
      where.roles = { has: role };
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        select: { id: true, name: true, email: true, roles: true, sectionId: true, adminModules: true, bpoPermissions: true },
        orderBy: { name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.account.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async update(
    @Param('id') id: string,
    @Body() body: { sectionId?: string | null; roles?: AccountRole[]; adminModules?: string[]; bpoPermissions?: string[] },
    @CurrentUser() requester: JwtUser,
  ) {
    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);
    if (requester.id === id) throw new BadRequestException('Cannot edit your own account');
    const target = await this.prisma.account.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('Account not found');
    if (target.roles.includes(AccountRole.super_admin)) {
      throw new ForbiddenException('Cannot modify super admin accounts');
    }
    if (!isSuperAdmin) {
      // Admin can only edit user/bpo in their own section
      if (target.sectionId !== requester.sectionId) {
        throw new ForbiddenException('You can only edit accounts in your own section');
      }
      if (target.roles.some(r => r === AccountRole.admin || r === AccountRole.director)) {
        throw new ForbiddenException('Admins cannot edit other admins or directors');
      }
    }
    const data: { sectionId?: string | null; roles?: AccountRole[]; adminModules?: string[]; bpoPermissions?: string[] } = {};
    if ('sectionId' in body && isSuperAdmin) data.sectionId = body.sectionId ?? null;
    if (body.roles?.length) {
      if (body.roles.includes(AccountRole.super_admin)) {
        throw new ForbiddenException('Cannot grant super_admin via this endpoint');
      }
      if (!isSuperAdmin && body.roles.some(r => r === AccountRole.admin || r === AccountRole.director)) {
        throw new ForbiddenException('Admins cannot grant admin or director roles');
      }
      data.roles = body.roles;
    }
    // Only super_admin can set adminModules (on admin accounts) or bpoPermissions (on bpo accounts)
    if ('adminModules' in body && isSuperAdmin && Array.isArray(body.adminModules)) {
      if (target.roles.includes(AccountRole.admin)) {
        data.adminModules = body.adminModules;
      }
    }
    if ('bpoPermissions' in body && isSuperAdmin && Array.isArray(body.bpoPermissions)) {
      if (target.roles.includes(AccountRole.bpo)) {
        data.bpoPermissions = body.bpoPermissions;
      }
    }
    return this.prisma.account.update({ where: { id }, data, select: { id: true, name: true, email: true, roles: true, sectionId: true, adminModules: true, bpoPermissions: true } });
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async remove(@Param('id') id: string, @CurrentUser() requester: JwtUser) {
    if (requester.id === id) throw new BadRequestException('You cannot delete your own account');

    const target = await this.prisma.account.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('Account not found');

    const isSuperAdmin = requester.roles.includes(AccountRole.super_admin);

    if (target.roles.includes(AccountRole.super_admin)) {
      throw new ForbiddenException('Super admin accounts cannot be deleted');
    }
    if (target.roles.includes(AccountRole.admin) && !isSuperAdmin) {
      throw new ForbiddenException('Only super admins can delete admin accounts');
    }
    if (!isSuperAdmin && target.sectionId !== requester.sectionId) {
      throw new ForbiddenException('You can only delete accounts in your own section');
    }

    await this.prisma.account.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
