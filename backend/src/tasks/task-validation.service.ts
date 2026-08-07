import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FormFieldTipo } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { unlink } from 'fs/promises';
import { extname } from 'path';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { isClosed, normalizeDate, parseScheduleString } from '../queue/handlers/didi-food.util';
import { SectionAccessService } from '../sections/section-access.service';

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
  'scheduled_targeted_menu_upload',
  'add_shops_to_integration',
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
      return ['Shop ID / App Shop ID', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    case 'schedule_update_dates':
      return ['Shop ID / App Shop ID', 'Date 1', 'Schedule 1', 'Date 2', 'Schedule 2', '...'];
    case 'stock_update':
      return ['app_shop_id / shop_id', 'UPC', 'Stock'];
    case 'library_menu_upload':
      return ['app_shop_id / shop_id', 'UPC', 'Price', 'Discount (optional)'];
    case 'add_shops_to_integration':
      return ['shop_id', 'app_shop_id', 'picking_model', 'driver_cash_blocked', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    default:
      return ['Use the columns from the configured task template'];
  }
}

function formatExamples(
  handlerName: string | undefined,
  shops: Array<{ shopId: string; appShopId: string; name: string | null }>,
) {
  const first = shops[0];
  const second = shops[1];
  const shopId = first?.shopId ?? '5764607795237028465';
  const appShopId = second?.appShopId ?? 'MX-CIRCLEK-001';

  if (handlerName === 'schedule_update_permanent') {
    return [
      {
        title: 'Excel · Permanent Business Hours Update',
        headers: expectedColumns(handlerName),
        rows: [
          [shopId, '08:00-22:00', '08:00-13:00,14:00-22:00', '00:00-24:00', 'Closed', '', '9:00 - 18:00', '18:00-24:00'],
          [appShopId, '07:30-20:30', '07:30-20:30', '07:30-20:30', '07:30-20:30', '07:30-21:00', 'Closed', 'Closed'],
        ],
        rowLabels: [
          first?.name ? `shop_id real: ${first.name}` : 'Ejemplo usando shop_id',
          second?.name ? `app_shop_id real: ${second.name}` : 'Ejemplo usando app_shop_id',
        ],
        notes: [
          { es: 'La primera columna acepta un shop_id o un app_shop_id por fila.', en: 'The first column accepts either a shop_id or an app_shop_id on each row.' },
          { es: 'Cada fila debe conservar las siete columnas de Monday a Sunday.', en: 'Every row must keep all seven columns from Monday through Sunday.' },
          { es: 'Debe existir al menos un día abierto; una fila con los siete días cerrados se rechaza.', en: 'At least one day must be open; a row with all seven days closed is rejected.' },
        ],
      },
      {
        title: 'Valid schedule configurations / Configuraciones válidas por día',
        headers: ['Configuration / Configuración', 'Valid value / Valor válido', 'Result / Resultado'],
        rows: [
          ['Single / Un horario', '08:00-22:00', 'One range / Un rango'],
          ['Split / Horario dividido', '08:00-13:00,14:00-22:00', 'Comma-separated ranges / Rangos separados por coma'],
          ['24 hours / 24 horas', '00:00-24:00', 'Open all day / Abierto todo el día'],
          ['Closed / Cerrado', 'Closed', 'Case-insensitive / No distingue mayúsculas'],
          ['Blank / Vacío', '', 'Closed with warning / Cerrado con advertencia'],
          ['Flexible / Formato flexible', '9:00 - 18:00', 'One/two-digit hour and spaces / Hora de uno/dos dígitos y espacios'],
        ],
        rowLabels: [],
        notes: [
          { es: 'Las horas de inicio válidas son 00:00–23:59; la hora final también admite 24:00.', en: 'Valid start times are 00:00–23:59; the end time may also be 24:00.' },
          { es: 'Los minutos deben tener dos dígitos y estar entre 00 y 59.', en: 'Minutes require two digits and must be between 00 and 59.' },
        ],
      },
    ];
  }

  if (handlerName === 'schedule_update_dates') {
    return [
      {
        title: 'Excel · Specific Days Business Hours Update',
        headers: ['Shop ID / App Shop ID', 'Date 1', 'Schedule 1', 'Date 2', 'Schedule 2', 'Date 3', 'Schedule 3'],
        rows: [
          [shopId, '2026-12-24', '08:00-18:00', '2026-12-25', 'Closed', '2026-12-31', '08:00-13:00,14:00-20:00'],
          [appShopId, '2027-01-01', '00:00-24:00', '2027-01-06', '', '', ''],
        ],
        rowLabels: [
          first?.name ? `shop_id real: ${first.name}` : 'Ejemplo usando shop_id',
          second?.name ? `app_shop_id real: ${second.name}` : 'Ejemplo usando app_shop_id',
        ],
        notes: [
          { es: 'La primera columna acepta un shop_id o un app_shop_id por fila.', en: 'The first column accepts either a shop_id or an app_shop_id on each row.' },
          { es: 'Después agrega pares Date / Schedule. Puedes repetir tantos pares como necesites en la misma fila.', en: 'Then add Date / Schedule pairs. Repeat as many pairs as needed on the same row.' },
          { es: 'La fecha puede ser una celda de fecha de Excel o texto YYYY-MM-DD.', en: 'The date may be an Excel date cell or YYYY-MM-DD text.' },
        ],
      },
      {
        title: 'Valid date configurations / Configuraciones válidas por fecha',
        headers: ['Configuration / Configuración', 'Date / Fecha', 'Schedule / Horario', 'Result / Resultado'],
        rows: [
          ['Single / Un horario', '2026-12-24', '08:00-18:00', 'One range / Un rango'],
          ['Split / Horario dividido', '2026-12-31', '08:00-13:00,14:00-20:00', 'Comma-separated ranges / Rangos separados por coma'],
          ['24 hours / 24 horas', '2027-01-01', '00:00-24:00', 'Open all day / Abierto todo el día'],
          ['Closed / Cerrado', '2026-12-25', 'Closed', 'Closed all day / Cerrado todo el día'],
          ['Blank / Vacío', '2027-01-06', '', 'Closed with warning / Cerrado con advertencia'],
          ['Multiple dates / Varios días', 'Date 1 … Date N', 'Schedule 1 … Schedule N', 'Repeatable pairs / Pares repetibles'],
        ],
        rowLabels: [],
        notes: [
          { es: 'Cada horario admite las mismas variantes que el horario permanente.', en: 'Each schedule accepts the same variants as permanent business hours.' },
          { es: 'Un par completamente vacío al final de la fila se ignora.', en: 'A completely empty pair at the end of the row is ignored.' },
        ],
      },
    ];
  }

  return [];
}

@Injectable()
export class TaskValidationService {
  constructor(private prisma: PrismaService, private sectionAccess: SectionAccessService) {}

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

    if (!(await this.sectionAccess.canAccess(user.roles, taskType.sectionId))) {
      throw new ForbiddenException('You do not have access to this task type');
    }

    return taskType;
  }

  async getContext(taskTypeId: string, user: JwtUser) {
    const taskType = await this.assertTaskTypeAccess(taskTypeId, user);
    const handlerName = this.getFileHandler(taskType.stepDefinitions);
    const fileFields = taskType.formFields.filter(field => field.tipo === FormFieldTipo.file);
    const sampleShops = ['schedule_update_permanent', 'schedule_update_dates'].includes(handlerName ?? '')
      ? await this.prisma.shop.findMany({
          where: { deletedAt: null },
          select: { shopId: true, appShopId: true, name: true },
          orderBy: { updatedAt: 'desc' },
          take: 2,
        })
      : [];

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
      formatExamples: formatExamples(handlerName, sampleShops),
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
      const exampleText = context.formatExamples.length > 0
        ? `\n${context.formatExamples.map(example => [
            `${example.title}:`,
            example.headers.join(' | '),
            ...example.rows.map(row => row.map(value => value || (spanish ? '[vacío]' : '[blank]')).join(' | ')),
            ...example.notes.map(note => `- ${spanish ? note.es : note.en}`),
          ].join('\n')).join('\n\n')}`
        : '';
      answer = spanish
        ? `Acepto .xlsx de hasta ${rules.maxSizeMb} MB. Las columnas esperadas, en orden, son: ${rules.expectedColumns.join(', ')}.${exampleText}`
        : `I accept .xlsx files up to ${rules.maxSizeMb} MB. Expected columns, in order: ${rules.expectedColumns.join(', ')}.${exampleText}`;
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
    const result = handlerName === 'library_menu_upload' || handlerName === 'scheduled_targeted_menu_upload'
      ? this.validateMenuWorkbook(workbook)
      : this.validateSheet(sheet, handlerName);
    checks.push(...result.checks);
    const response = this.finishValidation(file.originalname, checks, result.validRows, result.totalRows);

    if (!response.canProceed) {
      await unlink(file.path).catch(() => undefined);
      return response;
    }

    return { ...response, tempPath: file.filename };
  }

  async validateImageUpload(taskTypeId: string, formFieldId: string, file: Express.Multer.File, user: JwtUser) {
    let taskType: Awaited<ReturnType<TaskValidationService['assertTaskTypeAccess']>>;
    try {
      taskType = await this.assertTaskTypeAccess(taskTypeId, user);
    } catch (error) {
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
    const field = taskType.formFields.find(item => item.id === formFieldId);
    if (!field || field.tipo !== ('image' as FormFieldTipo)) {
      await unlink(file.path).catch(() => undefined);
      throw new ForbiddenException('This image field does not belong to the selected task type');
    }
    const extension = extname(file.originalname).toLowerCase();
    const supported = ['.jpg', '.jpeg', '.png', '.gif'];
    if (!supported.includes(extension)) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('Only JPG, PNG or GIF images are supported');
    }
    return {
      originalName: file.originalname,
      tempPath: file.filename,
      canProceed: true,
      summary: 'Image validated and ready. DiDi requires a secure URL and a file smaller than 10 MB.',
      checks: [
        { id: 'access', label: 'Access permission', status: 'passed' as const, message: `Authorized as ${user.email}` },
        { id: 'image-type', label: 'Image format', status: 'passed' as const, message: `${extension.toUpperCase()} accepted; ${Math.ceil(file.size / 1024)} KB` },
      ],
      stats: { validRows: 1, totalRows: 1 },
    };
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
      case 'add_shops_to_integration': return this.validateShopOnboarding(sheet);
      default: return this.validateGeneric(sheet);
    }
  }

  private validatePermanentHours(sheet: ExcelJS.Worksheet) {
    const issues: ValidationIssue[] = [];
    const header = sheet.getRow(1);
    const expectedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const firstHeader = normalizeHeader(header.getCell(1).value);
    const headerOk = ['appshopid', 'shopid', 'shopidappshopid'].includes(firstHeader)
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

    return this.sheetResult(headerOk, 'Expected: Shop ID / App Shop ID, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.', issues, validRows, totalRows);
  }

  private validateSpecificDates(sheet: ExcelJS.Worksheet) {
    const issues: ValidationIssue[] = [];
    const firstHeader = normalizeHeader(sheet.getRow(1).getCell(1).value);
    const headerOk = ['appshopid', 'shopid', 'shopidappshopid'].includes(firstHeader) && sheet.getRow(1).actualCellCount >= 3;
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

    return this.sheetResult(headerOk, 'Expected: Shop ID / App Shop ID followed by one or more Date / Schedule pairs.', issues, validRows, totalRows);
  }

  private validateStock(sheet: ExcelJS.Worksheet) {
    return this.validateItemRows(sheet, false);
  }

  private validateMenu(sheet: ExcelJS.Worksheet) {
    return this.validateItemRows(sheet, true);
  }

  private validateMenuWorkbook(workbook: ExcelJS.Workbook) {
    const categoriesSheet = workbook.getWorksheet('Categories');
    const itemsSheet = workbook.getWorksheet('Items');
    if (!categoriesSheet || !itemsSheet) {
      return this.validateMenu(workbook.worksheets[0]);
    }

    const checks: AssistantCheck[] = [];
    const categoryHeaders = ['appcategoryid', 'categoryname'];
    const itemHeaders = ['appshopid', 'appitemid', 'upc', 'itemname', 'categoryid', 'price', 'discount'];
    const categoriesHeaderOk = categoryHeaders.every((header, index) =>
      normalizeHeader(categoriesSheet.getRow(1).getCell(index + 1).value) === header,
    );
    const itemsHeaderOk = itemHeaders.every((header, index) =>
      normalizeHeader(itemsSheet.getRow(1).getCell(index + 1).value) === header,
    );
    checks.push({
      id: 'menu-sheets', label: 'Menu worksheets',
      status: categoriesHeaderOk && itemsHeaderOk ? 'passed' : 'failed',
      message: categoriesHeaderOk && itemsHeaderOk
        ? 'Categories and Items worksheets have the expected columns.'
        : 'Expected Categories(app_category_id, category_name) and Items(app_shop_id, app_item_id, UPC, item_name, category_id, price, discount).',
    });

    const categories = new Map<string, string>();
    const categoryIssues: string[] = [];
    for (let rowNumber = 2; rowNumber <= categoriesSheet.actualRowCount; rowNumber += 1) {
      const id = cellText(categoriesSheet.getRow(rowNumber).getCell(1));
      const name = cellText(categoriesSheet.getRow(rowNumber).getCell(2));
      if (!id && !name) continue;
      if (!id || !name) categoryIssues.push(`Row ${rowNumber}: category ID and name are required.`);
      else if (categories.has(id)) categoryIssues.push(`Row ${rowNumber}: duplicate category ID ${id}.`);
      else categories.set(id, name);
    }
    if (categories.size > 30) categoryIssues.push(`The menu has ${categories.size} categories; DiDi supports at most 30.`);
    checks.push({
      id: 'menu-categories', label: 'Available categories',
      status: categories.size > 0 && categoryIssues.length === 0 ? 'passed' : 'failed',
      message: categories.size > 0 ? `${categories.size} available category(ies) found.` : 'No categories were provided.',
      details: [
        ...[...categories].slice(0, MAX_DETAIL_ITEMS).map(([id, name]) => `${id} — ${name}`),
        ...categoryIssues.slice(0, MAX_DETAIL_ITEMS),
      ],
    });

    const itemIssues: string[] = [];
    const shopCounts = new Map<string, number>();
    let totalRows = 0;
    let validRows = 0;
    for (let rowNumber = 2; rowNumber <= itemsSheet.actualRowCount; rowNumber += 1) {
      const row = itemsSheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const values = Array.from({ length: 7 }, (_, index) => cellText(row.getCell(index + 1)));
      const [shopId, appItemId, upc, itemName, categoryId, rawPrice, rawDiscount] = values;
      const before = itemIssues.length;
      if (!shopId || !appItemId || !upc || !itemName || !categoryId) {
        itemIssues.push(`Row ${rowNumber}: shop, item ID, UPC, item name and category are required.`);
      }
      if (categoryId && !categories.has(categoryId)) itemIssues.push(`Row ${rowNumber}: category ${categoryId} is not available.`);
      const price = Number(rawPrice.replace(',', '.'));
      const discount = rawDiscount ? Number(rawDiscount.replace(',', '.')) : 0;
      if (!rawPrice || !Number.isFinite(price) || price < 0) itemIssues.push(`Row ${rowNumber}: price must be zero or greater.`);
      if (!Number.isFinite(discount) || discount < 0) itemIssues.push(`Row ${rowNumber}: discount must be zero or greater.`);
      if (itemIssues.length === before) {
        validRows += 1;
        shopCounts.set(shopId, (shopCounts.get(shopId) ?? 0) + 1);
      }
    }
    const oversized = [...shopCounts].filter(([, count]) => count > 3000);
    oversized.forEach(([shopId, count]) => itemIssues.push(`${shopId}: ${count} items exceeds the 3000 item maximum.`));
    checks.push({
      id: 'menu-items', label: 'Store menu items',
      status: totalRows > 0 && itemIssues.length === 0 ? 'passed' : 'failed',
      message: totalRows > 0
        ? `${validRows}/${totalRows} rows are valid across ${shopCounts.size} target store(s).`
        : 'The Items worksheet has no data rows.',
      details: itemIssues.slice(0, MAX_DETAIL_ITEMS),
    });
    return { checks, validRows, totalRows };
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

  private validateShopOnboarding(sheet: ExcelJS.Worksheet) {
    const expected = ['shopid', 'appshopid', 'pickingmodel', 'drivercashblocked', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const header = sheet.getRow(1);
    const headerOk = expected.every((value, index) => normalizeHeader(header.getCell(index + 1).value) === value);
    const issues: ValidationIssue[] = [];
    let totalRows = 0;
    let validRows = 0;
    const validModels = new Set(['storepicking', 'qrcode2in1', 'prepaidcard2in1']);
    const validBooleans = new Set(['', 'true', 'false', '1', '0', 'yes', 'no', 'si']);

    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const before = issues.length;
      const shopId = cellText(row.getCell(1));
      const appShopId = cellText(row.getCell(2));
      const pickingModel = normalizeHeader(row.getCell(3).value);
      const cashBlock = normalizeHeader(row.getCell(4).value);
      if (!/^57\d{17}$/.test(shopId)) pushIssue(issues, rowNumber, 'shop_id must contain 19 digits and begin with 57.');
      if (!appShopId) pushIssue(issues, rowNumber, 'app_shop_id is required.');
      if (!validModels.has(pickingModel)) pushIssue(issues, rowNumber, 'picking_model must be store_picking, qr_code_2in1, or prepaid_card_2in1.');
      if (!validBooleans.has(cashBlock)) pushIssue(issues, rowNumber, 'driver_cash_blocked must be TRUE or FALSE; blank defaults to TRUE.');
      let openDays = 0;
      for (let column = 5; column <= 11; column += 1) {
        const raw = cellText(row.getCell(column));
        if (isClosed(raw)) continue;
        openDays += 1;
        try { parseScheduleString(raw); }
        catch (error) { pushIssue(issues, rowNumber, `Column ${column}: ${(error as Error).message}`); }
      }
      if (openDays === 0) pushIssue(issues, rowNumber, 'At least one day must be open.');
      if (issues.length === before) validRows += 1;
    }
    return this.sheetResult(
      headerOk,
      'Expected: shop_id, app_shop_id, picking_model, driver_cash_blocked, Monday ... Sunday.',
      issues,
      validRows,
      totalRows,
    );
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
