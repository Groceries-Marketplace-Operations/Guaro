import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  inspectXlsxArchive,
  isBlankXlsxCell,
  MAX_XLSX_CONTENT_CELLS,
  MAX_XLSX_DIMENSION_COLUMNS,
  MAX_XLSX_DIMENSION_ROWS,
  MAX_XLSX_MATERIALIZED_ROWS,
  MAX_XLSX_WORKSHEETS,
  normalizedXlsxHeader,
  plainXlsxCellText,
} from './create-stores-completion';

export const CREATE_NEW_BRAND_TASK_TYPE_ID = '73ea7698-8e91-49ae-b771-0e77ca90cb0a';
export const CREATE_NEW_BRAND_TASK_TYPE = 'Create New Brand';
export const CREATE_BRAND_STEP = 'Create Brand';
export const CREATE_BRAND_COMPLETION_ACTION = 'capture_created_brand_details';
export const CREATE_BRAND_RESULT_KIND = 'create_new_brand_completion';
export const CREATE_BRAND_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_CREATE_BRAND_IMPORT_BYTES = 2 * 1024 * 1024;

const MAX_BRAND_NAME_LENGTH = 300;
const BRAND_ID_PATTERN = /^57\d{17}$/;

type BrandColumn = 'brandName' | 'brandId';

const BRAND_HEADERS: Array<{
  key: BrandColumn;
  header: string;
  aliases: string[];
}> = [
  {
    key: 'brandName',
    header: 'nombre de la marca',
    aliases: ['nombredelamarca', 'nombremarca', 'brandname', 'marca'],
  },
  {
    key: 'brandId',
    header: 'brand id',
    aliases: ['brandid', 'idmarca'],
  },
];

export interface CreateBrandCompletionResult {
  kind: typeof CREATE_BRAND_RESULT_KIND;
  version: 1;
  brand: {
    brandName: string;
    brandId: string;
  };
}

function normalizedName(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') ?? '';
}

export function requiresCreateBrandCompletion(
  action: string | null | undefined,
  taskTypeId: string | null | undefined,
  taskTypeName: string | null | undefined,
  stepName: string | null | undefined,
) {
  return action === CREATE_BRAND_COMPLETION_ACTION
    || (
      normalizedName(stepName) === normalizedName(CREATE_BRAND_STEP)
      && (
        taskTypeId === CREATE_NEW_BRAND_TASK_TYPE_ID
        || normalizedName(taskTypeName) === normalizedName(CREATE_NEW_BRAND_TASK_TYPE)
      )
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCreateBrandCompletionResult(value: unknown): value is CreateBrandCompletionResult {
  return isRecord(value)
    && value.kind === CREATE_BRAND_RESULT_KIND
    && value.version === 1
    && isRecord(value.brand);
}

function requiredText(value: unknown, fieldLabel: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldLabel} is required before completing Create Brand`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new BadRequestException(`${fieldLabel} is required before completing Create Brand`);
  }
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${fieldLabel} is too long`);
  }
  return normalized;
}

export function parseCreateBrandCompletion(value: unknown): CreateBrandCompletionResult {
  if (!isRecord(value) || value.kind !== CREATE_BRAND_RESULT_KIND || value.version !== 1 || !isRecord(value.brand)) {
    throw new BadRequestException(
      'Brand name and Brand ID are required before completing Create Brand',
    );
  }

  const brandName = requiredText(value.brand.brandName, 'Brand name', MAX_BRAND_NAME_LENGTH);
  const brandId = requiredText(value.brand.brandId, 'Brand ID', 200);
  if (!BRAND_ID_PATTERN.test(brandId)) {
    throw new BadRequestException('Brand ID must contain exactly 19 digits and begin with 57');
  }

  return {
    kind: CREATE_BRAND_RESULT_KIND,
    version: 1,
    brand: { brandName, brandId },
  };
}

export function formatCreateBrandNote(result: CreateBrandCompletionResult) {
  return `Nombre de la marca: ${result.brand.brandName} | Brand ID: ${result.brand.brandId}`;
}

function styleHeader(sheet: ExcelJS.Worksheet, color: string) {
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
}

function addBrandColumns(sheet: ExcelJS.Worksheet) {
  sheet.columns = [
    { header: 'nombre de la marca', key: 'brandName', width: 42 },
    { header: 'brand id', key: 'brandId', width: 28 },
  ];
  sheet.getColumn('brandName').numFmt = '@';
  sheet.getColumn('brandId').numFmt = '@';
}

export async function buildCreateBrandWorkbook(result: CreateBrandCompletionResult): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tequila 1.0';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Marca creada', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  addBrandColumns(sheet);
  sheet.addRow(result.brand);
  styleHeader(sheet, 'FFFF6200');
  sheet.autoFilter = { from: 'A1', to: 'B1' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function isAllowedCreateBrandXlsxMime(mimeType: string | null | undefined) {
  const normalized = mimeType?.trim().toLocaleLowerCase('en-US');
  return normalized === CREATE_BRAND_XLSX_MIME
    || normalized === 'application/octet-stream'
    || normalized === 'application/zip'
    || normalized === '';
}

export async function parseCreateBrandWorkbook(content: Buffer): Promise<CreateBrandCompletionResult> {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new BadRequestException('The XLSX file is empty');
  }
  if (content.length > MAX_CREATE_BRAND_IMPORT_BYTES) {
    throw new BadRequestException('The XLSX file exceeds the 2 MB limit');
  }
  if (content.length < 4 || content.subarray(0, 4).toString('binary') !== 'PK\x03\x04') {
    throw new BadRequestException('The uploaded file is not a valid XLSX workbook');
  }

  inspectXlsxArchive(content);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(content).buffer);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('The uploaded file is not a valid XLSX workbook');
  }

  if (workbook.worksheets.length > MAX_XLSX_WORKSHEETS) {
    throw new BadRequestException(`The XLSX workbook cannot contain more than ${MAX_XLSX_WORKSHEETS} worksheets`);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('The XLSX workbook has no worksheets');
  if (sheet.rowCount > MAX_XLSX_DIMENSION_ROWS || sheet.columnCount > MAX_XLSX_DIMENSION_COLUMNS) {
    throw new BadRequestException('The first worksheet has an excessively large used range');
  }

  const columns = new Map<BrandColumn, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    if (typeof cell.value !== 'string') return;
    const header = normalizedXlsxHeader(cell.value);
    const definition = BRAND_HEADERS.find(candidate => candidate.aliases.includes(header));
    if (!definition) return;
    if (columnNumber > 32) {
      throw new BadRequestException('Required XLSX headers must appear within the first 32 columns');
    }
    if (columns.has(definition.key)) {
      throw new BadRequestException(`The XLSX file has more than one ${definition.header} column`);
    }
    columns.set(definition.key, columnNumber);
  });

  const missingHeaders = BRAND_HEADERS
    .filter(definition => !columns.has(definition.key))
    .map(definition => definition.header);
  if (missingHeaders.length > 0) {
    throw new BadRequestException(`Missing required XLSX headers: ${missingHeaders.join(', ')}`);
  }

  let importedBrand: { brandName: string; brandId: string } | null = null;
  let materializedRows = 0;
  let contentCells = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    materializedRows += 1;
    if (materializedRows > MAX_XLSX_MATERIALIZED_ROWS) {
      throw new BadRequestException('The first worksheet contains too many materialized rows');
    }
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (isBlankXlsxCell(cell)) return;
      contentCells += 1;
      if (contentCells > MAX_XLSX_CONTENT_CELLS) {
        throw new BadRequestException('The first worksheet contains too many populated cells');
      }
      if (columnNumber > 32) {
        throw new BadRequestException('Populated cells must appear within the first 32 columns');
      }
      if (typeof cell.value !== 'string') {
        throw new BadRequestException(
          `Cell ${cell.address} must be plain text; numbers, formulas, dates, links, and errors are not allowed`,
        );
      }
    });
    if (rowNumber === 1) return;

    const brandNameCell = row.getCell(columns.get('brandName')!);
    const brandIdCell = row.getCell(columns.get('brandId')!);
    if (isBlankXlsxCell(brandNameCell) && isBlankXlsxCell(brandIdCell)) return;
    if (importedBrand) {
      throw new BadRequestException('Create New Brand accepts exactly one brand per task');
    }
    importedBrand = {
      brandName: plainXlsxCellText(brandNameCell, 'nombre de la marca', rowNumber, false),
      brandId: plainXlsxCellText(brandIdCell, 'brand id', rowNumber, true),
    };
  });

  return parseCreateBrandCompletion({
    kind: CREATE_BRAND_RESULT_KIND,
    version: 1,
    brand: importedBrand,
  });
}

export async function buildCreateBrandImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tequila 1.0';
  const sheet = workbook.addWorksheet('Marca creada', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  addBrandColumns(sheet);
  styleHeader(sheet, 'FFFF6200');
  sheet.autoFilter = { from: 'A1', to: 'B1' };

  const example = workbook.addWorksheet('Ejemplo', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  addBrandColumns(example);
  example.addRow({ brandName: 'Marca Ejemplo', brandId: '5764607795237028465' });
  styleHeader(example, 'FF64748B');
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
