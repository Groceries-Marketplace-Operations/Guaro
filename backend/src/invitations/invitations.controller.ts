import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountRol } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
  @Roles(AccountRol.admin, AccountRol.super_admin)
  create(@CurrentUser() user: any, @Body() dto: CreateInvitationDto) {
    return this.invitationsService.create(
      user.id,
      user.roles,
      user.sectionId,
      dto,
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AccountRol.admin, AccountRol.super_admin)
  findAll(@CurrentUser() user: any) {
    return this.invitationsService.findAll(user.id, user.roles, user.sectionId);
  }

  // Endpoint público — el usuario llega con el token del link
  @Post(':token/use')
  use(@Param('token') token: string, @Body() dto: UseInvitationDto) {
    return this.invitationsService.use(token, dto);
  }
}
