import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { AccountRole, TaskStatus } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BlockStepDto } from './dto/block-step.dto';
import { CompleteStepDto } from './dto/complete-step.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { FailStepDto } from './dto/fail-step.dto';
import { TasksService } from './tasks.service';
import { TaskEngineService } from './task-engine.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TasksController {
  constructor(
    private tasksService: TasksService,
    private taskEngine: TaskEngineService,
  ) {}

  @Get()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findAll(
    @CurrentUser() u: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('q') q?: string,
    @Query('status') status?: TaskStatus,
    @Query('brandId') brandId?: string,
  ) {
    return this.tasksService.findAll(u.roles, u.id, u.sectionId, { page, limit, q, status, brandId });
  }

  @Get(':id')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findOne(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.tasksService.findOne(id, { roles: u.roles, accountId: u.id, sectionId: u.sectionId });
  }

  @Post()
  @Roles(AccountRole.user, AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(dto, u.id);
  }

  @Patch(':id/steps/:stepId/complete')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  completeStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: CompleteStepDto,
  ) {
    return this.tasksService.completeStep(id, stepId, dto.result, dto.note);
  }

  @Patch(':id/steps/:stepId/fail')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  failStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: FailStepDto,
  ) {
    return this.tasksService.failStep(id, stepId, dto.failureReason, dto.note);
  }

  @Patch(':id/steps/:stepId/block')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  blockStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: BlockStepDto,
  ) {
    return this.tasksService.blockStep(id, stepId, dto.note);
  }

  @Patch(':id/steps/:stepId/retry')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  retryStep(@Param('id') id: string, @Param('stepId') stepId: string) {
    return this.tasksService.retryStep(id, stepId);
  }

  @Patch(':id/steps/:stepId/start')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  startStep(@Param('id') id: string, @Param('stepId') stepId: string) {
    return this.tasksService.startStep(id, stepId);
  }

  @Patch(':id/steps/:stepId/assign')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  assignStep(
    @Param('stepId') stepId: string,
    @Body('accountId') accountId: string,
  ) {
    return this.taskEngine.assignStepManually(stepId, accountId);
  }

  @Post('upload-excel')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: join(process.cwd(), 'uploads', 'temp'),
      filename: (_, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
    }),
    fileFilter: (_, file, cb) => {
      const ok = /\.(xlsx|xls)$/i.test(file.originalname);
      cb(ok ? null : new BadRequestException('Only .xlsx and .xls files are allowed'), ok);
    },
    limits: { fileSize: 5 * 1024 * 1024 },
  }))
  uploadExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return { tempPath: file.filename, originalName: file.originalname };
  }
}
