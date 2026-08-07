import { BadRequestException, Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { readFile, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { AccountRole, TaskStatus } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BlockStepDto } from './dto/block-step.dto';
import { AssignStepDto } from './dto/assign-step.dto';
import { CompleteStepDto } from './dto/complete-step.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { FailStepDto } from './dto/fail-step.dto';
import { TasksService } from './tasks.service';
import { TaskValidationService } from './task-validation.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TasksController {
  constructor(
    private tasksService: TasksService,
    private taskValidation: TaskValidationService,
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

  @Get('templates/grocery-menu.xlsx')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  async groceryMenuTemplate(@Res() response: Response) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tequila 1.0';
    const categories = workbook.addWorksheet('Categories');
    categories.addRow(['app_category_id', 'category_name']);
    categories.addRow(['beverages', 'Beverages']);
    categories.addRow(['snacks', 'Snacks']);
    const items = workbook.addWorksheet('Items');
    items.addRow(['app_shop_id', 'app_item_id', 'UPC', 'item_name', 'category_id', 'price', 'discount']);
    items.addRow(['STORE_001', 'ITEM_001', '750100000001', 'Sparkling Water 600 ml', 'beverages', 25, 0]);
    items.addRow(['STORE_001', 'ITEM_002', '750100000002', 'Potato Chips 45 g', 'snacks', 32, 28]);
    for (const sheet of [categories, items]) {
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6900' } };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.columns.forEach(column => { column.width = 22; });
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
    }
    const buffer = await workbook.xlsx.writeBuffer();
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="tequila-grocery-menu-template.xlsx"');
    response.send(Buffer.from(buffer));
  }

  @Get('templates/add-shops.xlsx')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  async addShopsTemplate(@Res() response: Response) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tequila 1.0';
    const sheet = workbook.addWorksheet('Shops');
    sheet.addRow([
      'shop_id', 'app_shop_id', 'picking_model', 'driver_cash_blocked',
      'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    ]);
    sheet.addRow([
      '5764607795237028465', 'MX-SORIANA-001', 'store_picking', true,
      '08:00-22:00', '08:00-22:00', '08:00-22:00', '08:00-22:00', '08:00-22:00', '08:00-22:00', 'Closed',
    ]);
    sheet.addRow([
      '5764607795237028466', 'MX-SORIANA-002', 'qr_code_2in1', true,
      '00:00-24:00', '00:00-24:00', '00:00-24:00', '00:00-24:00', '00:00-24:00', '09:00-18:00', '09:00-18:00',
    ]);
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6200' } };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'K1' };
    sheet.columns.forEach((column, index) => { column.width = index < 4 ? 24 : 18; });
    for (let row = 2; row <= 1001; row += 1) {
      sheet.getCell(row, 3).dataValidation = {
        type: 'list', allowBlank: false,
        formulae: ['"store_picking,qr_code_2in1,prepaid_card_2in1"'],
      };
      sheet.getCell(row, 4).dataValidation = { type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'] };
    }
    const instructions = workbook.addWorksheet('Instructions');
    instructions.addRows([
      ['Field', 'Requirement'],
      ['shop_id', 'Required. DiDi shop_id: exactly 19 digits and begins with 57.'],
      ['app_shop_id', 'Required. Store identifier used by the selected brand application.'],
      ['picking_model', 'Required: store_picking, qr_code_2in1, or prepaid_card_2in1.'],
      ['driver_cash_blocked', 'Optional. Defaults to TRUE. Use FALSE only when explicitly authorized.'],
      ['Monday ... Sunday', 'Use HH:MM-HH:MM, comma-separated split ranges, 00:00-24:00, or Closed.'],
    ]);
    instructions.getRow(1).font = { bold: true };
    instructions.columns = [{ width: 28 }, { width: 90 }];
    const buffer = await workbook.xlsx.writeBuffer();
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="tequila-add-shops-template.xlsx"');
    response.send(Buffer.from(buffer));
  }

  @Get(':id')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  findOne(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.tasksService.findOne(id, { roles: u.roles, accountId: u.id, sectionId: u.sectionId });
  }

  @Post()
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  create(@CurrentUser() u: JwtUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(dto, u);
  }

  @Get('validation-assistant/:taskTypeId/context')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  assistantContext(@Param('taskTypeId') taskTypeId: string, @CurrentUser() u: JwtUser) {
    return this.taskValidation.getContext(taskTypeId, u);
  }

  @Post('validation-assistant/:taskTypeId/message')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  assistantMessage(
    @Param('taskTypeId') taskTypeId: string,
    @Body() body: { question?: string; locale?: string },
    @CurrentUser() u: JwtUser,
  ) {
    return this.taskValidation.answer(taskTypeId, body.question?.trim() ?? '', body.locale, u);
  }

  @Patch(':id/steps/:stepId/complete')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  completeStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: CompleteStepDto,
    @CurrentUser() u: JwtUser,
  ) {
    return this.tasksService.completeStep(id, stepId, dto.result, dto.note, u);
  }

  @Patch(':id/steps/:stepId/fail')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  failStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: FailStepDto,
    @CurrentUser() u: JwtUser,
  ) {
    return this.tasksService.failStep(id, stepId, dto.failureReason, dto.note, u);
  }

  @Patch(':id/steps/:stepId/block')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  blockStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: BlockStepDto,
    @CurrentUser() u: JwtUser,
  ) {
    return this.tasksService.blockStep(id, stepId, dto.note, u);
  }

  @Patch(':id/steps/:stepId/retry')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  retryStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: JwtUser) {
    return this.tasksService.retryStep(id, stepId, u);
  }

  @Patch(':id/steps/:stepId/force-retry')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  forceRetryStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: JwtUser) {
    return this.tasksService.forceRetryStep(id, stepId, u);
  }

  @Patch(':id/steps/:stepId/start')
  @Roles(AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  startStep(@Param('id') id: string, @Param('stepId') stepId: string, @CurrentUser() u: JwtUser) {
    return this.tasksService.startStep(id, stepId, u);
  }

  @Patch(':id/steps/:stepId/assign')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  assignStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: AssignStepDto,
    @CurrentUser() u: JwtUser,
  ) {
    return this.tasksService.assignStep(id, stepId, dto.accountId, u);
  }

  @Get(':id/steps/:stepId/download')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin, AccountRole.director)
  async downloadExport(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Query('format') format: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    if (format !== undefined && format !== 'xlsx' && format !== 'json') {
      throw new BadRequestException('Export format must be xlsx or json');
    }
    const { fileKey, mimeType } = await this.tasksService.getStepExport(
      id,
      stepId,
      { roles: u.roles, accountId: u.id, sectionId: u.sectionId },
      format ?? 'xlsx',
    );
    const filepath = join(process.cwd(), 'uploads', 'exports', fileKey);
    let data: Buffer;
    try {
      data = await readFile(filepath);
    } catch {
      throw new NotFoundException('File not found or already downloaded');
    }
    return {
      fileKey,
      mimeType,
      contentBase64: data.toString('base64'),
    };
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
      cb(ok ? null : new BadRequestException('Only Excel files are allowed'), ok);
    },
    limits: { fileSize: 5 * 1024 * 1024 },
  }))
  async uploadExcel(
    @UploadedFile() file: Express.Multer.File,
    @Body('taskTypeId') taskTypeId: string,
    @Body('formFieldId') formFieldId: string,
    @CurrentUser() u: JwtUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!taskTypeId || !formFieldId) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('Task type and file field are required');
    }
    return this.taskValidation.validateUpload(taskTypeId, formFieldId, file, u);
  }

  @Post('upload-image')
  @Roles(AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.super_admin)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_, __, cb) => {
        const destination = join(process.cwd(), 'uploads', 'task-assets');
        mkdirSync(destination, { recursive: true });
        cb(null, destination);
      },
      filename: (_, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
    }),
    fileFilter: (_, file, cb) => {
      const ok = /\.(jpe?g|png|gif)$/i.test(file.originalname)
        && ['image/jpeg', 'image/png', 'image/gif'].includes(file.mimetype);
      cb(ok ? null : new BadRequestException('Only JPG, PNG or GIF images are allowed'), ok);
    },
    limits: { fileSize: 10 * 1024 * 1024 },
  }))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('taskTypeId') taskTypeId: string,
    @Body('formFieldId') formFieldId: string,
    @CurrentUser() u: JwtUser,
  ) {
    if (!file) throw new BadRequestException('No image uploaded');
    if (!taskTypeId || !formFieldId) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('Task type and image field are required');
    }
    return this.taskValidation.validateImageUpload(taskTypeId, formFieldId, file, u);
  }
}
