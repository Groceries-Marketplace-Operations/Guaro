import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { NetoAutomationService } from './neto-automation.service';

@Controller('integrations/neto-automation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class NetoAutomationController {
  constructor(private readonly service: NetoAutomationService) {}

  @Get()
  status() { return this.service.getStatus(); }

  @Post('enabled')
  setEnabled(@Body('enabled') enabled: unknown) { return this.service.setEnabled(enabled); }
}
