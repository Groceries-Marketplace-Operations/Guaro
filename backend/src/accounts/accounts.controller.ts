import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
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
  list(@Query('role') role?: AccountRole) {
    return this.prisma.account.findMany({
      where: {
        deletedAt: null,
        ...(role && { roles: { has: role } }),
      },
      select: { id: true, name: true, email: true, roles: true, sectionId: true },
      orderBy: { name: 'asc' },
    });
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
