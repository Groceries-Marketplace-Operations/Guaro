import {
  Controller, DefaultValuePipe, Get, ParseIntPipe,
  Query, UseGuards,
} from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.super_admin)
@Controller('admin')
export class AdminController {
  constructor(private svc: AdminService) {}

  @Get('queue-status')
  queueStatus() {
    return this.svc.getQueueStatus();
  }

  @Get('handler-logs')
  handlerLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.svc.getHandlerLogs(page, limit, status);
  }
}
