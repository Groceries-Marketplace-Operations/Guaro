import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FormFieldTipo } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { readFile, unlink } from 'fs/promises';
import { extname } from 'path';
import { inflateSync } from 'zlib';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { isClosed, normalizeDate, parseScheduleString } from '../queue/handlers/didi-food.util';
import { SectionAccessService } from '../sections/section-access.service';
import { PermissionAccessService } from '../access-control/permission-access.service';

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
  'commercial_menu_upload',
  'add_shops_to_integration',
]);

const MAX_DETAIL_ITEMS = 20;
const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function pngCrc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDecodedLength(width: number, height: number, bitsPerPixel: number, interlace: number) {
  const scanlineLength = (columns: number) => 1 + Math.ceil((columns * bitsPerPixel) / 8);
  let length = 0;
  if (interlace === 0) {
    length = height * scanlineLength(width);
  } else {
    const passes = [
      [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
    ];
    for (const [startX, startY, stepX, stepY] of passes) {
      const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
      const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
      if (passWidth && passHeight) length += passHeight * scanlineLength(passWidth);
    }
  }
  return Number.isSafeInteger(length) && length > 0 && length <= MAX_DECODED_IMAGE_BYTES ? length : null;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) return null;
    const type = buffer.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    if (pngCrc32(buffer.subarray(typeStart, dataEnd)) !== buffer.readUInt32BE(dataEnd)) return null;

    if (!sawHeader && type !== 'IHDR') return null;
    if (sawImageData && type !== 'IDAT') imageDataEnded = true;
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) return null;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      interlace = buffer[dataStart + 12];
      if (
        !width
        || !height
        || !validDepths[colorType]?.includes(bitDepth)
        || buffer[dataStart + 10] !== 0
        || buffer[dataStart + 11] !== 0
        || ![0, 1].includes(interlace)
      ) return null;
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (sawImageData || [0, 4].includes(colorType) || length === 0 || length % 3 !== 0 || length > 768) return null;
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (!sawHeader || imageDataEnded || length === 0) return null;
      sawImageData = true;
      imageData.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0 || !sawImageData || chunkEnd !== buffer.length) return null;
      sawEnd = true;
      offset = chunkEnd;
      break;
    } else if (/^[A-Z]/.test(type)) {
      // PNG only defines IHDR, PLTE, IDAT and IEND as critical chunks.
      return null;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== buffer.length || (colorType === 3 && !sawPalette)) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const expectedLength = pngDecodedLength(width, height, channels * bitDepth, interlace);
  if (!expectedLength) return null;
  try {
    const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength + 1 });
    if (decoded.length !== expectedLength) return null;
  } catch {
    return null;
  }
  return { width, height };
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  let sawScan = false;
  let sawEntropyData = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset];
    const markerStart = offset - 1;
    offset += 1;
    if (marker === 0xd9) return dimensions && sawScan && sawEntropyData ? dimensions : null;
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (offset + 2 > buffer.length) return null;
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) return null;
    const segmentEnd = offset + size;

    if (startOfFrameMarkers.has(marker)) {
      if (size < 11) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      const components = buffer[offset + 7];
      if (!width || !height || !components || size !== 8 + (components * 3)) return null;
      dimensions = { width, height };
    }

    offset = segmentEnd;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        sawEntropyData = true;
        offset += 1;
        continue;
      }
      const entropyMarkerStart = offset;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return null;
      const entropyMarker = buffer[offset];
      if (entropyMarker === 0x00) {
        sawEntropyData = true;
        offset += 1;
        continue;
      }
      if (entropyMarker >= 0xd0 && entropyMarker <= 0xd7) {
        offset += 1;
        continue;
      }
      offset = entropyMarkerStart;
      break;
    }
    if (offset === markerStart) return null;
  }
  return null;
}

function readImageDimensions(buffer: Buffer, extension: string): { width: number; height: number } | null {
  if (extension === '.png') return readPngDimensions(buffer);
  if (extension === '.jpg' || extension === '.jpeg') return readJpegDimensions(buffer);
  return null;
}

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
    case 'commercial_menu_upload':
      return ['category_id', 'UPC_SKU', 'price', 'activity_price', 'image_url', 'item_name_optional'];
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
        titleZh: 'Excel · 永久营业时间更新',
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
          { es: 'La primera columna acepta un shop_id o un app_shop_id por fila.', en: 'The first column accepts either a shop_id or an app_shop_id on each row.', zh: '每行第一列可以填写 shop_id 或 app_shop_id。' },
          { es: 'Cada fila debe conservar las siete columnas de Monday a Sunday.', en: 'Every row must keep all seven columns from Monday through Sunday.', zh: '每行必须保留从 Monday 到 Sunday 的全部七列。' },
          { es: 'Debe existir al menos un día abierto; una fila con los siete días cerrados se rechaza.', en: 'At least one day must be open; a row with all seven days closed is rejected.', zh: '至少必须有一天营业；七天全部关闭的行将被拒绝。' },
        ],
      },
      {
        title: 'Valid schedule configurations / Configuraciones válidas por día',
        titleZh: '有效的每日营业时间配置',
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
          { es: 'Las horas de inicio válidas son 00:00–23:59; la hora final también admite 24:00.', en: 'Valid start times are 00:00–23:59; the end time may also be 24:00.', zh: '有效的开始时间为 00:00–23:59；结束时间也可以是 24:00。' },
          { es: 'Los minutos deben tener dos dígitos y estar entre 00 y 59.', en: 'Minutes require two digits and must be between 00 and 59.', zh: '分钟必须使用两位数字，且范围为 00 到 59。' },
        ],
      },
    ];
  }

  if (handlerName === 'schedule_update_dates') {
    return [
      {
        title: 'Excel · Specific Days Business Hours Update',
        titleZh: 'Excel · 特定日期营业时间更新',
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
          { es: 'La primera columna acepta un shop_id o un app_shop_id por fila.', en: 'The first column accepts either a shop_id or an app_shop_id on each row.', zh: '每行第一列可以填写 shop_id 或 app_shop_id。' },
          { es: 'Después agrega pares Date / Schedule. Puedes repetir tantos pares como necesites en la misma fila.', en: 'Then add Date / Schedule pairs. Repeat as many pairs as needed on the same row.', zh: '然后添加 Date / Schedule 配对；同一行可按需重复任意数量的配对。' },
          { es: 'La fecha puede ser una celda de fecha de Excel o texto YYYY-MM-DD.', en: 'The date may be an Excel date cell or YYYY-MM-DD text.', zh: '日期可以是 Excel 日期单元格，也可以是 YYYY-MM-DD 格式的文本。' },
        ],
      },
      {
        title: 'Valid date configurations / Configuraciones válidas por fecha',
        titleZh: '有效的日期配置',
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
          { es: 'Cada horario admite las mismas variantes que el horario permanente.', en: 'Each schedule accepts the same variants as permanent business hours.', zh: '每个营业时间都支持与永久营业时间相同的格式。' },
          { es: 'Un par completamente vacío al final de la fila se ignora.', en: 'A completely empty pair at the end of the row is ignored.', zh: '行末完全为空的配对会被忽略。' },
        ],
      },
    ];
  }

  return [];
}

@Injectable()
export class TaskValidationService {
  constructor(
    private prisma: PrismaService,
    private sectionAccess: SectionAccessService,
    private permissionAccess: PermissionAccessService,
  ) {}

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

    const canCreateAcrossSections = await this.permissionAccess.can(user, ['tasks.create_all_sections']);
    if (!canCreateAcrossSections && !(await this.sectionAccess.canAccess(user, taskType.sectionId))) {
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
    const chinese = locale?.toLowerCase().startsWith('zh');
    const rules = context.fileRules[0];
    let answer: string;

    if (/permiso|permission|acceso|access|权限|访问/.test(q)) {
      answer = chinese
        ? `是的。你的账户 ${user.email} 有权访问 ${context.taskTypeName}。上传文件和创建任务时，系统会再次检查相同的授权。`
        : spanish
          ? `Sí. Tu cuenta ${user.email} tiene acceso a ${context.taskTypeName}. La misma autorización se vuelve a comprobar al subir el archivo y al crear la tarea.`
          : `Yes. ${user.email} has access to ${context.taskTypeName}. The same authorization is checked again when uploading and creating the task.`;
    } else if (/plantilla|template|模板/.test(q)) {
      answer = context.templates.length
        ? (chinese
          ? `请使用已配置的模板：${context.templates.map(t => t.name).join(', ')}。你可以在“模板”部分打开。`
          : spanish
            ? `Usa la plantilla configurada: ${context.templates.map(t => t.name).join(', ')}. Puedes abrirla desde la sección Plantillas.`
            : `Use the configured template: ${context.templates.map(t => t.name).join(', ')}. You can open it from Templates.`)
        : (chinese
          ? '此任务没有配置模板。我会直接验证系统中定义的字段。'
          : spanish
            ? 'Esta tarea no tiene una plantilla configurada. Validaré los campos definidos directamente en el sistema.'
            : 'This task has no configured template. I will validate the fields defined directly in the system.');
    } else if (/columna|column|formato|format|excel|xlsx|列|格式|表格/.test(q) && rules) {
      const exampleText = context.formatExamples.length > 0
        ? `\n${context.formatExamples.map(example => [
            `${chinese ? example.titleZh : example.title}:`,
            example.headers.join(' | '),
            ...example.rows.map(row => row.map(value => value || (chinese ? '[空白]' : spanish ? '[vacío]' : '[blank]')).join(' | ')),
            ...example.notes.map(note => `- ${chinese ? note.zh : spanish ? note.es : note.en}`),
          ].join('\n')).join('\n\n')}`
        : '';
      answer = chinese
        ? `我接受最大 ${rules.maxSizeMb} MB 的 .xlsx 文件。预期列按顺序为：${rules.expectedColumns.join(', ')}。${exampleText}`
        : spanish
          ? `Acepto .xlsx de hasta ${rules.maxSizeMb} MB. Las columnas esperadas, en orden, son: ${rules.expectedColumns.join(', ')}.${exampleText}`
          : `I accept .xlsx files up to ${rules.maxSizeMb} MB. Expected columns, in order: ${rules.expectedColumns.join(', ')}.${exampleText}`;
    } else if (/error|falla|failed|invalid|inválid|错误|失败|无效/.test(q)) {
      answer = chinese
        ? '上传文件时，我会显示确切的行号和原因。请修正这些行后重新上传；系统不会保留被拒绝的文件。'
        : spanish
          ? 'Al subir el archivo te indicaré la fila y el motivo exacto. Corrige esas filas y vuelve a subirlo; el sistema no guardará un archivo rechazado.'
          : 'When you upload the file I will show the exact row and reason. Fix those rows and upload it again; rejected files are not kept.';
    } else if (/requer|falta|missing|field|campo|必填|缺失|字段|要求/.test(q)) {
      answer = chinese
        ? `必填字段：${context.requiredFields.join(', ') || '无'}。`
        : spanish
          ? `Los campos requeridos son: ${context.requiredFields.join(', ') || 'ninguno'}.`
          : `Required fields: ${context.requiredFields.join(', ') || 'none'}.`;
    } else {
      answer = chinese
        ? '我可以帮助你了解模板、Excel 列、权限、必填字段或验证错误。'
        : spanish
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
      : handlerName === 'commercial_menu_upload'
        ? this.validateCommercialMenuWorkbook(workbook)
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
    const supported = ['.jpg', '.jpeg', '.png'];
    if (!supported.includes(extension)) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('Only JPG, JPEG or PNG images are supported');
    }
    const dimensions = readImageDimensions(await readFile(file.path), extension);
    if (!dimensions) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('The uploaded file is not a valid JPG, JPEG or PNG image');
    }
    const isLogo = field.label.trim().toLocaleLowerCase('en-US') === 'shop logo';
    if (!isLogo && (dimensions.width < 1200 || dimensions.height < 900)) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException(`The cover must be at least 1200 x 900 px; received ${dimensions.width} x ${dimensions.height} px`);
    }
    const checks = [
      { id: 'access', label: 'Access permission', status: 'passed' as const, message: `Authorized as ${user.email}` },
      { id: 'image-type', label: 'Image format', status: 'passed' as const, message: `${extension.toUpperCase()} accepted; ${Math.ceil(file.size / 1024)} KB (maximum 5 MB)` },
      {
        id: 'image-size',
        label: isLogo ? 'Logo dimensions' : 'Cover dimensions',
        status: 'passed' as const,
        message: `${dimensions.width} x ${dimensions.height} px; original dimensions preserved`,
      },
      ...(isLogo ? [] : [
        { id: 'image-framing', label: 'DiDi framing', status: 'warning' as const, message: 'DiDi may display the cover as 4:3 or crop it to the centered 2:1 area. Keep logos, faces and text away from the top and bottom edges.' },
        { id: 'image-review', label: 'DiDi review', status: 'warning' as const, message: 'Only one cover can be under review at a time; another submission may be rejected until review finishes.' },
      ]),
    ];
    return {
      originalName: file.originalname,
      tempPath: file.filename,
      canProceed: true,
      summary: isLogo
        ? 'Original logo validated and stored without resizing, cropping, padding or recompression. DiDi will receive the uploaded JPG or PNG file as-is.'
        : 'Original cover validated and stored without resizing, cropping, padding or recompression. DiDi will receive the uploaded JPG or PNG file as-is.',
      checks,
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

  private validateCommercialMenuWorkbook(workbook: ExcelJS.Workbook) {
    const categoriesSheet = workbook.getWorksheet('Categories');
    const itemsSheet = workbook.getWorksheet('Items');
    const checks: AssistantCheck[] = [];
    if (!categoriesSheet || !itemsSheet) {
      return {
        checks: [{
          id: 'commercial-menu-sheets', label: 'Commercial menu worksheets', status: 'failed' as const,
          message: 'Expected Categories and Items worksheets. Download a fresh template for the selected brand.',
        }],
        validRows: 0,
        totalRows: 0,
      };
    }

    const categoryHeadersOk = normalizeHeader(categoriesSheet.getRow(1).getCell(1).value) === 'categoryid'
      && normalizeHeader(categoriesSheet.getRow(1).getCell(2).value) === 'categoryname';
    const expectedItemHeaders = ['categoryid', 'upcsku', 'price', 'activityprice', 'imageurl', 'itemnameoptional'];
    const itemHeadersOk = expectedItemHeaders.every((header, index) =>
      normalizeHeader(itemsSheet.getRow(1).getCell(index + 1).value) === header,
    );
    checks.push({
      id: 'commercial-menu-columns', label: 'Template structure',
      status: categoryHeadersOk && itemHeadersOk ? 'passed' : 'failed',
      message: categoryHeadersOk && itemHeadersOk
        ? 'The generated template structure is valid.'
        : 'Do not rename the Categories/Items sheets or their columns; download a fresh template.',
    });

    const categories = new Set<string>();
    for (let rowNumber = 2; rowNumber <= categoriesSheet.actualRowCount; rowNumber += 1) {
      const id = cellText(categoriesSheet.getRow(rowNumber).getCell(1));
      const name = cellText(categoriesSheet.getRow(rowNumber).getCell(2));
      if (!id && !name) continue;
      if (id && name) categories.add(id);
    }
    checks.push({
      id: 'commercial-menu-categories', label: 'Configured categories',
      status: categories.size > 0 && categories.size <= 30 ? 'passed' : 'failed',
      message: categories.size > 0 && categories.size <= 30
        ? `${categories.size} category(ies) are available in the brand template.`
        : 'The template must contain between 1 and 30 categories.',
    });

    const issues: string[] = [];
    const upcs = new Set<string>();
    let totalRows = 0;
    let validRows = 0;
    for (let rowNumber = 2; rowNumber <= itemsSheet.actualRowCount; rowNumber += 1) {
      const row = itemsSheet.getRow(rowNumber);
      if (isBlankRow(row)) continue;
      totalRows += 1;
      const before = issues.length;
      const categoryId = cellText(row.getCell(1));
      const upc = cellText(row.getCell(2));
      const rawPrice = cellText(row.getCell(3)).replace(',', '.');
      const rawActivity = cellText(row.getCell(4)).replace(',', '.');
      const imageUrl = cellText(row.getCell(5));
      const price = Number(rawPrice);
      const activity = rawActivity ? Number(rawActivity) : undefined;
      if (!categoryId || !categories.has(categoryId)) issues.push(`Row ${rowNumber}: select a category_id from Categories.`);
      if (!upc) issues.push(`Row ${rowNumber}: UPC_SKU is required.`);
      else if (upcs.has(upc)) issues.push(`Row ${rowNumber}: UPC_SKU ${upc} is repeated.`);
      if (!rawPrice || !Number.isFinite(price) || price < 0) issues.push(`Row ${rowNumber}: price must be zero or greater.`);
      if (activity !== undefined && (!Number.isFinite(activity) || activity < 0 || activity > price)) {
        issues.push(`Row ${rowNumber}: activity_price must be between zero and price.`);
      }
      if (!/^https:\/\//i.test(imageUrl)) issues.push(`Row ${rowNumber}: image_url must be a public HTTPS URL.`);
      if (upc) upcs.add(upc);
      if (issues.length === before) validRows += 1;
    }
    if (totalRows > 3000) issues.push(`The workbook has ${totalRows} items; the maximum is 3000.`);
    checks.push({
      id: 'commercial-menu-items', label: 'Menu items',
      status: totalRows > 0 && issues.length === 0 ? 'passed' : 'failed',
      message: totalRows > 0 ? `${validRows}/${totalRows} item rows are valid.` : 'The Items worksheet has no data rows.',
      details: issues.slice(0, MAX_DETAIL_ITEMS),
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
