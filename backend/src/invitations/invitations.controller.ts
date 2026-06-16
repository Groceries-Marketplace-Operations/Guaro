import { Body, Controller, Delete, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UseInvitationDto } from './dto/use-invitation.dto';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(private invitationsService: InvitationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateInvitationDto) {
    return this.invitationsService.create(user.id, user.roles, user.sectionId, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AccountRole.admin, AccountRole.super_admin)
  findAll(
    @CurrentUser() user: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    return this.invitationsService.findAll(user.id, user.roles, user.sectionId, { page, limit });
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AccountRole.admin, AccountRole.super_admin)
  delete(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.invitationsService.delete(id, user.id, user.roles);
  }

  // Endpoint público — el usuario llega con el token del link
  @Post(':token/use')
  use(@Param('token') token: string, @Body() dto: UseInvitationDto) {
    return this.invitationsService.use(token, dto);
  }
}
