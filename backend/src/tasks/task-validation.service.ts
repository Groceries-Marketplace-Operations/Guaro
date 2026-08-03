import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, FormFieldTipo } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { unlink } from 'fs/promises';
import { extname } from 'path';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { isClosed, normalizeDate, parseScheduleString } from '../queue/handlers/didi-food.util';

type CheckStatus = 'passed' | 'warning' | 'failed';

export interface AssistantCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

interface ValidationIssue {
  row: number;
  message: string;
  severity?: 'warning' | 'failed';
}

const KNOWN_FILE_HANDLERS = new Set([
  'schedule_update_permanent',
  'schedule_update_dates',
  'stock_update',
  'library_menu_upload',
]);

const MAX_DETAIL_ITEMS = 20;

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cellText(cell: ExcelJS.Cell): string {
  return cell.text?.trim() ?? String(cell.value ?? '').trim();
}

function isBlankRow(row: ExcelJS.Row): boolean {
  for (let index = 1; index <= Math.max(1, row.cellCount); index += 1) {
    if (cellText(row.getCell(index))) return false;
  }
  return true;
}

function pushIssue(issues: ValidationIssue[], row: number, message: string, severity: 'warning' | 'failed' = 'failed') {
  issues.push({ row, message, severity });
}

function expectedColumns(handlerName?: string): string[] {
  switch (handlerName) {
    case 'schedule_update_permanent':
      return ['app_shop_id / shop_id', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    case 'schedule_update_dates':
      return ['app_shop_id / shop_id', 'Date 1', 'Schedule 1', 'Date 2', 'Schedule 2', '...'];
    case 'stock_update':
      return ['app_shop_id / shop_id', 'UPC', 'Stock'];
    case 'library_menu_upload':
      return ['app_shop_id / shop_id', 'UPC', 'Price', 'Discount (optional)'];
    default:
      return ['Use the columns from the configured task template'];
  }
}

@Injectable()
export class TaskValidationService {
  constructor(private prisma: PrismaService) {}

  async assertTaskTypeAccess(taskTypeId: string, user: JwtUser) {
    const taskType = await this.prisma.taskType.findUnique({
      where: { id: taskTypeId },
      include: {
        section: { select: { id: true, name: true } },
        formFields: { orderBy: { order: 'asc' } },
        templates: { orderBy: { createdAt: 'asc' } },
        stepDefinitions: {
          orderBy: { order: 'asc' },
          include: { handler: { select: { name: true } } },
        },
      },
    });

    if (!taskType || taskType.deletedAt || !taskType.active) {
      throw new NotFoundException('Task type is not available');
    }

    const isSuperAdmin = user.roles.includes(AccountRole.super_admin);
    const isSectionAdmin = user.roles.includes(AccountRole.admin) && !isSuperAdmin;
    if (isSectionAdmin && taskType.sectionId !== user.sectionId) {
      throw new ForbiddenException('You do not have access to this task type');
    }

    return taskType;
  }

  async getContext(taskTypeId: string, user: JwtUser) {
    const taskType = await this.assertTaskTypeAccess(taskTypeId, user);
    const handlerName = this.getFileHandler(taskType.stepDefinitions);
    const fileFields = taskType.formFields.filter(field => field.tipo === FormFieldTipo.file);

    return {
      assistantName: 'Naranja',
      taskTypeId: taskType.id,
      taskTypeName: taskType.name,
      canAccess: true,
      accessMessage: `Access confirmed for ${user.email}`,
      hasFileValidation: fileFields.length > 0,
      fileRules: fileFields.map(field => ({
        fieldId: field.id,
        fieldLabel: field.label,
        acceptedExtensions: ['.xlsx'],
        maxSizeMb: 5,
        expectedColumns: expectedColumns(handlerName),
        validator: handlerName && KNOWN_FILE_HANDLERS.has(handlerName) ? handlerName : 'generic_excel',
      })),
      requiredFields: taskType.formFields.filter(field => field.required).map(field => field.label),
      templates: taskType.templates.map(template => ({
        name: template.name,
        url: template.url,
        type: template.tipo,
      })),
      greeting: fileFields.length
        ? `I can validate your file before creating “${taskType.name}”. Ask me about the template, columns, permissions, or an error.`
        : `I can review the required fields and formats for “${taskType.name}” before you create it.`,
    };
  }

  async answer(taskTypeId: string, question: string, locale: string | undefined, user: JwtUser) {
    const context = await this.getContext(taskTypeId, user);
    const q = question.toLocaleLowerCase();
    const spanish = locale?.toLowerCase().startsWith('es');
    const rules = context.fileRules[0];
    let answer: string;

    if (/permiso|permission|acceso|access/.test(q)) {
      answer = spanish
        ? `Sí. Tu cuenta ${user.email} tiene acceso a ${context.taskTypeName}. La misma autorización se vuelve a comprobar al subir el archivo y al crear la tarea.`
        : `Yes. ${user.email} has access to ${context.taskTypeName}. The same authorization is checked again when uploading and creating the task.`;
    } else if (/plantilla|template/.test(q)) {
      answer = context.templates.length
        ? (spanish ? `Usa la plantilla configurada: ${context.templates.map(t => t.name).join(', ')}. Puedes abrirla desde la sección Plantillas.` : `Use the configured template: ${context.templates.map(t => t.name).join(', ')}. You can open it from Templates.`)
        : (spanish ? 'Esta tarea no tiene una plantilla configurada. Validaré los campos definidos directamente en el sistema.' : 'This task has no configured template. I will validate the fields defined directly in the system.');
    } else if (/columna|column|formato|format|excel|xlsx/.test(q) && rules) {
      answer = spanish
        ? `Acepto .xlsx de hasta ${rules.maxSizeMb} MB. Las columnas esperadas, en orden, son: ${rules.expectedColumns.join(', ')}.`
        : `I accept .xlsx files up to ${rules.maxSizeMb} MB. Expected columns, in order: ${rules.expectedColumns.join(', ')}.`;
    } else if (/error|falla|failed|invalid|inválid/.test(q)) {
      answer = spanish
        ? 'Al subir el archivo te indicaré la fila y el motivo exacto. Corrige esas filas y vuelve a subirlo; el sistema no guardará un archivo rechazado.'
        : 'When you upload the file I will show the exact row and reason. Fix those rows and upload it again; rejected files are not kept.';
    } else if (/requer|falta|missing|field|campo/.test(q)) {
      answer = spanish
        ? `Los campos requeridos son: ${context.requiredFields.join(', ') || 'ninguno'}.`
        : `Required fields: ${context.requiredFields.join(', ') || 'none'}.`;
    } else {
      answer = spanish
        ? 'Puedo ayudarte con: plantilla, columnas del Excel, permisos, campos requeridos o errores de validación.'
        : 'I can help with the template, Excel columns, permissions, required fields, or validation errors.';
    }

    return { answer };
  }

  async validateUpload(taskTypeId: string, formFieldId: string, file: Express.Multer.File, user: JwtUser) {
    let taskType: Awaited<ReturnType<TaskValidationService['assertTaskTypeAccess']>>;
    try {
      taskType = await this.assertTaskTypeAccess(taskTypeId, user);
    } catch (error) {
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
    const field = taskType.formFields.find(item => item.id === formFieldId);
    if (!field || field.tipo !== FormFieldTipo.file) {
      await unlink(file.path).catch(() => undefined);
      throw new ForbiddenException('This file field does not belong to the selected task type');
    }

    const checks: AssistantCheck[] = [{
      id: 'access',
      label: 'Access permission',
      status: 'passed',
      message: `Authorized as ${user.email}`,
    }];

    const extension = extname(file.originalname).toLowerCase();
    if (extension !== '.xlsx') {
      checks.push({
        id: 'file-type',
        label: 'File format',
        status: 'failed',
        message: `${extension || 'Unknown format'} is not supported. Export the system template as .xlsx.`,
      });
      await unlink(file.path).catch(() => undefined);
      return this.finishValidation(file.originalname, checks, 0, 0);
    }
    checks.push({ id: 'file-type', label: 'File format', status: 'passed', message: 'Valid .xlsx file (maximum 5 MB)' });

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(file.path);
    } catch {
      checks.push({ id: 'workbook', label: 'Excel workbook', status: 'failed', message: 'The file is damaged, encrypted, or is not a real .xlsx workbook.' });
      await unlink(file.path).catch(() => undefined);
      return this.finishValidation(file.originalname, checks, 0, 0);
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      checks.push({ id: 'workbook', label: 'Excel workbook', status: 'failed', message: 'The workbook has no worksheet.' });
      await unlink(file.path).catch(() => undefined);
      return this.finishValidation(file.originalname, checks, 0, 0);
    }
    checks.push({ id: 'workbook', label: 'Excel workbook', status: 'passed', message: `Worksheet “${sheet.name}” is readable.` });

    const handlerName = this.getFileHandler(taskType.stepDefinitions);
    const result = this.validateSheet(sheet, handlerName);
    checks.push(...result.checks);
    const response = this.finishValidation(file.originalname, checks, result.validRows, result.totalRows);

    if (!response.canProceed) {
      await unlink(file.path).catch(() => undefined);
      return response;
    }

    return { ...response, tempPath: file.filename };
  }

  private getFileHandler(steps: { handler: { name: string } | null }[]): string | undefined {
    return steps.map(step => step.handler?.name).find(name => !!name && KNOWN_FILE_HANDLERS.has(name));
  }

  private validateSheet(sheet: ExcelJS.Worksheet, handlerName?: string) {
    switch (handlerName) {
      case 'schedule_update_permanent': return this.validatePermanentHours(sheet);
      case 'schedule_update_dates': return this.validateSpecificDates(sheet);
      case 'stock_update': return this.validateStock(sheet);
      case 'library_menu_upload': return this.validateMenu(sheet);
      default: return this.validateGeneric(sheet);
    }
  }

  private validatePermanentHours(sheet: ExcelJS.Worksheet) {
    const issues: ValidationIssue[] = [];
    const header = sheet.getRow(1);
    const expectedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const firstHeader = normalizeHeader(header.getCell(1).value);
    const headerOk = ['appshopid', 'shopid'].includes(firstHeader)
      && expectedDays.every((day, index) => normalizeHeader(header.getCell(index + 2).value) === day);
    let totalRows = 0;
    let validRows = 0;

    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const before = issues.length;
      const shopId = cellText(row.getCell(1));
      if (!shopId) pushIssue(issues, rowNumber, 'Missing app_shop_id / shop_id in column A.');
      let openDays = 0;
      for (let column = 2; column <= 8; column += 1) {
        const raw = cellText(row.getCell(column));
        if (!raw) pushIssue(issues, rowNumber, `Column ${column}: blank value will be treated as closed.`, 'warning');
        if (isClosed(raw)) continue;
        openDays += 1;
        try { parseScheduleString(raw); } catch (error) { pushIssue(issues, rowNumber, `Column ${column}: ${(error as Error).message}`); }
      }
      if (openDays === 0) pushIssue(issues, rowNumber, 'All seven days are closed; the current handler cannot apply a row without at least one open day.');
      if (!issues.slice(before).some(issue => issue.severity !== 'warning')) validRows += 1;
    }

    return this.sheetResult(headerOk, 'Expected: app_shop_id, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.', issues, validRows, totalRows);
  }

  private validateSpecificDates(sheet: ExcelJS.Worksheet) {
    const issues: ValidationIssue[] = [];
    const firstHeader = normalizeHeader(sheet.getRow(1).getCell(1).value);
    const headerOk = ['appshopid', 'shopid'].includes(firstHeader) && sheet.getRow(1).actualCellCount >= 3;
    let totalRows = 0;
    let validRows = 0;

    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const before = issues.length;
      if (!cellText(row.getCell(1))) pushIssue(issues, rowNumber, 'Missing app_shop_id / shop_id in column A.');
      let pairs = 0;
      for (let column = 2; column <= Math.max(row.actualCellCount, 3); column += 2) {
        const dateValue = row.getCell(column).value;
        const schedule = cellText(row.getCell(column + 1));
        if (dateValue == null && !schedule) continue;
        if (dateValue == null) {
          pushIssue(issues, rowNumber, `Column ${column}: a date is required for this schedule.`);
          continue;
        }
        pairs += 1;
        try { normalizeDate(dateValue instanceof Date ? dateValue : cellText(row.getCell(column))); }
        catch (error) { pushIssue(issues, rowNumber, `Column ${column}: ${(error as Error).message}`); }
        if (!schedule) pushIssue(issues, rowNumber, `Column ${column + 1}: blank schedule will be treated as closed.`, 'warning');
        else if (!isClosed(schedule)) {
          try { parseScheduleString(schedule); } catch (error) { pushIssue(issues, rowNumber, `Column ${column + 1}: ${(error as Error).message}`); }
        }
      }
      if (pairs === 0) pushIssue(issues, rowNumber, 'Add at least one Date / Schedule pair.');
      if (!issues.slice(before).some(issue => issue.severity !== 'warning')) validRows += 1;
    }

    return this.sheetResult(headerOk, 'Expected: app_shop_id followed by one or more Date / Schedule pairs.', issues, validRows, totalRows);
  }

  private validateStock(sheet: ExcelJS.Worksheet) {
    return this.validateItemRows(sheet, false);
  }

  private validateMenu(sheet: ExcelJS.Worksheet) {
    return this.validateItemRows(sheet, true);
  }

  private validateItemRows(sheet: ExcelJS.Worksheet, menu: boolean) {
    const issues: ValidationIssue[] = [];
    const header = sheet.getRow(1);
    const first = normalizeHeader(header.getCell(1).value);
    const second = normalizeHeader(header.getCell(2).value);
    const third = normalizeHeader(header.getCell(3).value);
    const headerOk = ['appshopid', 'shopid'].includes(first) && ['upc', 'appitemid'].includes(second)
      && (menu ? ['price', 'precio'].includes(third) : third === 'stock');
    let totalRows = 0;
    let validRows = 0;
    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const before = issues.length;
      if (!cellText(row.getCell(1))) pushIssue(issues, rowNumber, 'Missing app_shop_id / shop_id.');
      if (!cellText(row.getCell(2))) pushIssue(issues, rowNumber, 'Missing UPC / app_item_id.');
      const amountRaw = cellText(row.getCell(3)).replace(',', '.');
      const amount = Number(amountRaw);
      if (!amountRaw || !Number.isFinite(amount) || amount < 0 || (!menu && !Number.isInteger(amount))) {
        pushIssue(issues, rowNumber, menu ? 'Price must be a number greater than or equal to zero.' : 'Stock must be an integer greater than or equal to zero.');
      }
      if (!issues.slice(before).some(issue => issue.severity !== 'warning')) validRows += 1;
    }
    return this.sheetResult(headerOk, menu ? 'Expected: app_shop_id, UPC, Price, Discount (optional).' : 'Expected: app_shop_id, UPC, Stock.', issues, validRows, totalRows);
  }

  private validateGeneric(sheet: ExcelJS.Worksheet) {
    const totalRows = Math.max(0, sheet.actualRowCount - 1);
    const checks: AssistantCheck[] = [{
      id: 'rows',
      label: 'Data rows',
      status: totalRows > 0 ? 'passed' : 'failed',
      message: totalRows > 0 ? `${totalRows} data row(s) found.` : 'The worksheet has no data rows.',
    }];
    return { checks, validRows: totalRows, totalRows };
  }

  private sheetResult(headerOk: boolean, headerMessage: string, issues: ValidationIssue[], validRows: number, totalRows: number) {
    const failed = issues.filter(issue => issue.severity !== 'warning');
    const warnings = issues.filter(issue => issue.severity === 'warning');
    const checks: AssistantCheck[] = [{
      id: 'columns',
      label: 'Column format',
      status: headerOk ? 'passed' : 'failed',
      message: headerOk ? 'Headers match the system format.' : headerMessage,
    }];
    checks.push({
      id: 'rows',
      label: 'Row validation',
      status: totalRows === 0 || failed.length > 0 ? 'failed' : warnings.length > 0 ? 'warning' : 'passed',
      message: totalRows === 0
        ? 'The worksheet has no data rows.'
        : failed.length > 0
          ? `${failed.length} error(s) found in ${totalRows} data row(s).`
          : warnings.length > 0
            ? `${validRows} row(s) are valid with ${warnings.length} warning(s).`
            : `${validRows} row(s) are valid.`,
      details: issues.slice(0, MAX_DETAIL_ITEMS).map(issue => `Row ${issue.row}: ${issue.message}`),
    });
    return { checks, validRows, totalRows };
  }

  private finishValidation(originalName: string, checks: AssistantCheck[], validRows: number, totalRows: number) {
    const canProceed = !checks.some(check => check.status === 'failed');
    return {
      originalName,
      canProceed,
      summary: canProceed
        ? `Validation complete. ${validRows} row(s) are ready.`
        : 'I found issues that must be corrected before creating the task.',
      checks,
      stats: { validRows, totalRows },
    };
  }
}
