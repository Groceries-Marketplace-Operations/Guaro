import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';

export const CREATE_NEW_STORES_TASK_TYPE = 'Create New Stores';
export const CREATE_STORES_STEP = 'Create Stores';
export const CREATE_STORES_COMPLETION_ACTION = 'capture_created_store_details';
export const CREATE_STORES_RESULT_KIND = 'create_new_stores_completion';
export const CREATE_STORES_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_CREATE_STORES_IMPORT_BYTES = 2 * 1024 * 1024;

const MAX_STORES_PER_COMPLETION = 1_000;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_STORE_NAME_LENGTH = 300;
const MAX_COVERAGE_LENGTH = 500;
const MAX_XLSX_ZIP_ENTRIES = 128;
const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_ENTRY_NAME_BYTES = 512;
const MAX_XLSX_WORKSHEETS = 8;
const MAX_XLSX_DIMENSION_ROWS = 100_000;
const MAX_XLSX_DIMENSION_COLUMNS = 256;
const MAX_XLSX_MATERIALIZED_ROWS = 5_000;
const MAX_XLSX_CONTENT_CELLS = 10_000;

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;

// Keep this in lockstep with ExcelJS 4.4.0's worksheet-entry matcher. Its
// expression is intentionally not anchored, so the archive inspection must
// also bound entries with prefixes or suffixes that ExcelJS would still parse.
const EXCELJS_WORKSHEET_ENTRY = /xl\/worksheets\/sheet(\d+)[.]xml/;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

type CreateStoresColumn = keyof CreateStoresCompletionRow;

const CREATE_STORES_HEADERS: Array<{
  key: CreateStoresColumn;
  header: string;
  aliases: string[];
}> = [
  {
    key: 'appShopId',
    header: 'appshopid',
    aliases: ['appshopid', 'appshop', 'applicationstoreid'],
  },
  {
    key: 'shopId',
    header: 'shopid',
    aliases: ['shopid', 'idtienda'],
  },
  {
    key: 'storeName',
    header: 'nombre de la tienda',
    aliases: ['nombredelatienda', 'nombredetienda', 'nombretienda', 'nombre', 'storename', 'shopname'],
  },
  {
    key: 'coverage',
    header: 'coverage',
    aliases: ['coverage', 'cobertura'],
  },
];

export function isAllowedCreateStoresXlsxMime(mimeType: string | null | undefined) {
  const normalized = mimeType?.trim().toLocaleLowerCase('en-US');
  return normalized === CREATE_STORES_XLSX_MIME
    || normalized === 'application/octet-stream'
    || normalized === 'application/zip'
    || normalized === '';
}

export interface CreateStoresCompletionRow {
  appShopId: string;
  shopId: string;
  storeName: string;
  coverage: string;
}

export interface CreateStoresCompletionResult {
  kind: typeof CREATE_STORES_RESULT_KIND;
  version: 1;
  stores: CreateStoresCompletionRow[];
}

function normalizedName(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') ?? '';
}

export function requiresCreateStoresCompletion(
  action: string | null | undefined,
  taskTypeName: string | null | undefined,
  stepName: string | null | undefined,
) {
  return action === CREATE_STORES_COMPLETION_ACTION
    || (
      normalizedName(taskTypeName) === normalizedName(CREATE_NEW_STORES_TASK_TYPE)
      && normalizedName(stepName) === normalizedName(CREATE_STORES_STEP)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCreateStoresCompletionResult(value: unknown): value is CreateStoresCompletionResult {
  return isRecord(value) && value.kind === CREATE_STORES_RESULT_KIND;
}

function requiredText(
  value: unknown,
  fieldLabel: string,
  rowNumber: number,
  maxLength: number,
) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldLabel} is required for store ${rowNumber}`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new BadRequestException(`${fieldLabel} is required for store ${rowNumber}`);
  }
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${fieldLabel} is too long for store ${rowNumber}`);
  }
  return normalized;
}

function requiredShopId(value: unknown, rowNumber: number) {
  const shopId = requiredText(value, 'Shop ID', rowNumber, MAX_IDENTIFIER_LENGTH);
  if (!/^57\d{17}$/.test(shopId)) {
    throw new BadRequestException(
      `Shop ID must contain exactly 19 digits and begin with 57 for store ${rowNumber}`,
    );
  }
  return shopId;
}

export function parseCreateStoresCompletion(value: unknown): CreateStoresCompletionResult {
  if (!isRecord(value) || value.kind !== CREATE_STORES_RESULT_KIND || value.version !== 1) {
    throw new BadRequestException(
      'App Shop ID, Shop ID, store name, and coverage are required before completing Create Stores',
    );
  }
  if (!Array.isArray(value.stores) || value.stores.length === 0) {
    throw new BadRequestException('Add at least one store before completing Create Stores');
  }
  if (value.stores.length > MAX_STORES_PER_COMPLETION) {
    throw new BadRequestException(`A maximum of ${MAX_STORES_PER_COMPLETION} stores can be completed at once`);
  }

  const stores = value.stores.map((row, index) => {
    if (!isRecord(row)) {
      throw new BadRequestException(`Store ${index + 1} is invalid`);
    }
    return {
      appShopId: requiredText(row.appShopId, 'App Shop ID', index + 1, MAX_IDENTIFIER_LENGTH),
      shopId: requiredShopId(row.shopId, index + 1),
      storeName: requiredText(row.storeName, 'Store name', index + 1, MAX_STORE_NAME_LENGTH),
      coverage: requiredText(row.coverage, 'Coverage', index + 1, MAX_COVERAGE_LENGTH),
    };
  });

  const duplicateAppShopId = stores.find((store, index) => (
    stores.findIndex(candidate => candidate.appShopId === store.appShopId) !== index
  ));
  if (duplicateAppShopId) {
    throw new BadRequestException(`App Shop ID ${duplicateAppShopId.appShopId} is duplicated`);
  }
  const duplicateShopId = stores.find((store, index) => (
    stores.findIndex(candidate => candidate.shopId === store.shopId) !== index
  ));
  if (duplicateShopId) {
    throw new BadRequestException(`Shop ID ${duplicateShopId.shopId} is duplicated`);
  }

  return {
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores,
  };
}

export function formatCreateStoresNote(result: CreateStoresCompletionResult) {
  return [
    `Tiendas creadas: ${result.stores.length}`,
    ...result.stores.map((store, index) => (
      `- ${index + 1}. appshopid: ${store.appShopId} | shopid: ${store.shopId} | `
      + `nombre de la tienda: ${store.storeName} | coverage: ${store.coverage}`
    )),
  ].join('\n');
}

export async function buildCreateStoresWorkbook(
  result: CreateStoresCompletionResult,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tequila 1.0';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Tiendas creadas', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  sheet.columns = [
    { header: 'appshopid', key: 'appShopId', width: 28 },
    { header: 'shopid', key: 'shopId', width: 28 },
    { header: 'nombre de la tienda', key: 'storeName', width: 42 },
    { header: 'coverage', key: 'coverage', width: 36 },
  ];
  sheet.getColumn('appShopId').numFmt = '@';
  sheet.getColumn('shopId').numFmt = '@';
  result.stores.forEach(store => sheet.addRow(store));

  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6200' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.autoFilter = { from: 'A1', to: 'D1' };
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'middle' };
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function normalizedHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]/g, '');
}

function plainCellText(
  cell: ExcelJS.Cell,
  label: string,
  rowNumber: number,
  identifier: boolean,
) {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;

  if (identifier && typeof value === 'number') {
    throw new BadRequestException(
      `${label} in row ${rowNumber} must be stored as text so Excel does not round or remove leading zeros`,
    );
  }
  throw new BadRequestException(
    `${label} in row ${rowNumber} must be plain text; numbers, formulas, dates, links, and errors are not allowed`,
  );
}

function isBlankCell(cell: ExcelJS.Cell) {
  const value = cell.value;
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function invalidWorkbook(message: string): never {
  throw new BadRequestException(`The uploaded XLSX workbook is invalid: ${message}`);
}

function findEndOfCentralDirectory(content: Buffer) {
  if (content.length < 22) {
    invalidWorkbook('ZIP end-of-central-directory record is missing or malformed');
  }
  const minimumOffset = Math.max(0, content.length - 22 - 0xffff);
  for (let offset = content.length - 22; offset >= minimumOffset; offset -= 1) {
    if (content.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = content.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === content.length) return offset;
  }
  invalidWorkbook('ZIP end-of-central-directory record is missing or malformed');
}

function assertSafeZipExtraFields(extra: Buffer, entryName: string) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) invalidWorkbook(`malformed ZIP metadata for ${entryName}`);
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length) invalidWorkbook(`malformed ZIP metadata for ${entryName}`);
    if (fieldId === 0x0001) invalidWorkbook('ZIP64 archives are not supported');
    offset += fieldLength;
  }
}

function crc32(content: Buffer) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function countXmlStartTags(content: Buffer, tagName: string, maximum: number, entryName: string) {
  const needle = Buffer.from(`<${tagName}`, 'ascii');
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    const next = content[offset + needle.length];
    if (next === 9 || next === 10 || next === 13 || next === 32 || next === 47 || next === 62) {
      count += 1;
      if (count > maximum) {
        invalidWorkbook(`XML entry ${entryName} contains too many ${tagName} elements`);
      }
    }
    offset += needle.length;
  }
}

/**
 * Bounds the ZIP work before ExcelJS sees it. XLSX is a ZIP container and a
 * small compressed upload can otherwise expand to an unbounded amount of RAM.
 */
function inspectXlsxArchive(content: Buffer) {
  const endOffset = findEndOfCentralDirectory(content);
  if (
    (endOffset >= 20 && content.readUInt32LE(endOffset - 20) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR)
    || (endOffset >= 4 && content.readUInt32LE(endOffset - 4) === ZIP64_END_OF_CENTRAL_DIRECTORY)
  ) {
    invalidWorkbook('ZIP64 archives are not supported');
  }

  const diskNumber = content.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = content.readUInt16LE(endOffset + 6);
  const entriesOnDisk = content.readUInt16LE(endOffset + 8);
  const entryCount = content.readUInt16LE(endOffset + 10);
  const centralDirectorySize = content.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = content.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    invalidWorkbook('multi-disk ZIP archives are not supported');
  }
  if (
    entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    invalidWorkbook('ZIP64 archives are not supported');
  }
  if (entryCount === 0) invalidWorkbook('ZIP archive has no entries');
  if (entryCount > MAX_XLSX_ZIP_ENTRIES) {
    invalidWorkbook(`ZIP archive has more than ${MAX_XLSX_ZIP_ENTRIES} entries`);
  }
  if (
    centralDirectoryOffset < 4
    || centralDirectorySize > content.length
    || centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    invalidWorkbook('ZIP central directory is outside the uploaded file');
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  let worksheetEntryCount = 0;
  const entryNames = new Set<string>();
  const localRanges: Array<{ start: number; end: number; name: string }> = [];

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > endOffset || content.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      invalidWorkbook('ZIP central directory entry is malformed');
    }
    const flags = content.readUInt16LE(cursor + 8);
    const compressionMethod = content.readUInt16LE(cursor + 10);
    const expectedCrc = content.readUInt32LE(cursor + 16);
    const compressedSize = content.readUInt32LE(cursor + 20);
    const uncompressedSize = content.readUInt32LE(cursor + 24);
    const fileNameLength = content.readUInt16LE(cursor + 28);
    const extraLength = content.readUInt16LE(cursor + 30);
    const commentLength = content.readUInt16LE(cursor + 32);
    const diskStart = content.readUInt16LE(cursor + 34);
    const localHeaderOffset = content.readUInt32LE(cursor + 42);
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      invalidWorkbook('encrypted ZIP entries are not supported');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      invalidWorkbook(`unsupported ZIP compression method ${compressionMethod}`);
    }
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || diskStart === 0xffff
    ) {
      invalidWorkbook('ZIP64 archives are not supported');
    }
    if (diskStart !== 0) invalidWorkbook('multi-disk ZIP archives are not supported');
    if (fileNameLength === 0 || fileNameLength > MAX_XLSX_ENTRY_NAME_BYTES) {
      invalidWorkbook('ZIP entry name is empty or too long');
    }

    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > endOffset) invalidWorkbook('ZIP central directory entry exceeds its declared bounds');
    const fileNameBytes = content.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const entryName = fileNameBytes.toString('utf8');
    if (
      /[\u0000-\u001f\u007f]/.test(entryName)
      || entryName.includes('\ufffd')
      || entryName.includes('\\')
      || entryName.startsWith('/')
      || /^[a-z]:/i.test(entryName)
      || entryName.split('/').includes('..')
    ) {
      invalidWorkbook('ZIP entry has an unsafe path');
    }
    const comparableName = entryName.toLocaleLowerCase('en-US');
    if (entryNames.has(comparableName)) invalidWorkbook(`duplicate ZIP entry ${entryName}`);
    entryNames.add(comparableName);
    assertSafeZipExtraFields(
      content.subarray(cursor + 46 + fileNameLength, cursor + 46 + fileNameLength + extraLength),
      entryName,
    );

    if (uncompressedSize > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
      invalidWorkbook(`ZIP entry ${entryName} exceeds the 8 MB uncompressed limit`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) {
      invalidWorkbook('ZIP archive exceeds the 16 MB total uncompressed limit');
    }

    if (
      localHeaderOffset + 30 > centralDirectoryOffset
      || content.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER
    ) {
      invalidWorkbook(`local ZIP header for ${entryName} is missing or malformed`);
    }
    const localFlags = content.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = content.readUInt16LE(localHeaderOffset + 8);
    const localCrc = content.readUInt32LE(localHeaderOffset + 14);
    const localCompressedSize = content.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = content.readUInt32LE(localHeaderOffset + 22);
    const localFileNameLength = content.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = content.readUInt16LE(localHeaderOffset + 28);
    if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0) {
      invalidWorkbook('encrypted ZIP entries are not supported');
    }
    if (localFlags !== flags || localCompressionMethod !== compressionMethod) {
      invalidWorkbook(`conflicting ZIP metadata for ${entryName}`);
    }
    if (localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
      invalidWorkbook('ZIP64 archives are not supported');
    }
    if ((flags & 0x0008) === 0 && (
      localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
    )) {
      invalidWorkbook(`conflicting ZIP sizes or checksum for ${entryName}`);
    }

    const localNameStart = localHeaderOffset + 30;
    const localExtraStart = localNameStart + localFileNameLength;
    const dataStart = localExtraStart + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralDirectoryOffset || dataEnd > centralDirectoryOffset) {
      invalidWorkbook(`compressed data for ${entryName} exceeds its declared bounds`);
    }
    const localName = content.subarray(localNameStart, localExtraStart);
    if (!localName.equals(fileNameBytes)) invalidWorkbook(`conflicting ZIP name for ${entryName}`);
    assertSafeZipExtraFields(content.subarray(localExtraStart, dataStart), entryName);

    const compressedData = content.subarray(dataStart, dataEnd);
    let uncompressedData: Buffer;
    try {
      if (compressionMethod === 0) {
        if (compressedSize !== uncompressedSize) {
          invalidWorkbook(`stored ZIP entry ${entryName} has conflicting sizes`);
        }
        uncompressedData = Buffer.from(compressedData);
      } else {
        uncompressedData = inflateRawSync(compressedData, {
          maxOutputLength: Math.min(uncompressedSize + 1, MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES + 1),
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      invalidWorkbook(`compressed data for ${entryName} is malformed or exceeds its limit`);
    }
    if (uncompressedData.length !== uncompressedSize) {
      invalidWorkbook(`uncompressed size for ${entryName} does not match ZIP metadata`);
    }
    if (crc32(uncompressedData) !== expectedCrc) {
      invalidWorkbook(`checksum for ${entryName} does not match ZIP metadata`);
    }
    if (EXCELJS_WORKSHEET_ENTRY.test(entryName)) {
      worksheetEntryCount += 1;
      if (worksheetEntryCount > MAX_XLSX_WORKSHEETS) {
        invalidWorkbook(`XLSX package has more than ${MAX_XLSX_WORKSHEETS} worksheet entries`);
      }
      countXmlStartTags(uncompressedData, 'row', MAX_XLSX_MATERIALIZED_ROWS, entryName);
      countXmlStartTags(uncompressedData, 'c', MAX_XLSX_CONTENT_CELLS, entryName);
    } else if (comparableName === 'xl/sharedstrings.xml') {
      countXmlStartTags(uncompressedData, 'si', MAX_XLSX_CONTENT_CELLS, entryName);
    }

    localRanges.push({ start: localHeaderOffset, end: dataEnd, name: entryName });
    cursor = entryEnd;
  }

  if (cursor !== endOffset) invalidWorkbook('ZIP central directory size does not match its entries');
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      invalidWorkbook(`overlapping ZIP entries ${localRanges[index - 1].name} and ${localRanges[index].name}`);
    }
  }
  if (!entryNames.has('[content_types].xml') || !entryNames.has('xl/workbook.xml')) {
    invalidWorkbook('required XLSX package entries are missing');
  }
}

/**
 * Parses the first worksheet from an XLSX upload without persisting anything.
 * Completion validation remains centralized in parseCreateStoresCompletion.
 */
export async function parseCreateStoresWorkbook(
  content: Buffer,
): Promise<CreateStoresCompletionResult> {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new BadRequestException('The XLSX file is empty');
  }
  if (content.length > MAX_CREATE_STORES_IMPORT_BYTES) {
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

  const headerRow = sheet.getRow(1);
  const columns = new Map<CreateStoresColumn, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    if (typeof cell.value !== 'string') return;
    const header = normalizedHeader(cell.value);
    const definition = CREATE_STORES_HEADERS.find(candidate => candidate.aliases.includes(header));
    if (!definition) return;
    if (columnNumber > 32) {
      throw new BadRequestException('Required XLSX headers must appear within the first 32 columns');
    }
    if (columns.has(definition.key)) {
      throw new BadRequestException(`The XLSX file has more than one ${definition.header} column`);
    }
    columns.set(definition.key, columnNumber);
  });

  const missingHeaders = CREATE_STORES_HEADERS
    .filter(definition => !columns.has(definition.key))
    .map(definition => definition.header);
  if (missingHeaders.length > 0) {
    throw new BadRequestException(`Missing required XLSX headers: ${missingHeaders.join(', ')}`);
  }

  const stores: CreateStoresCompletionRow[] = [];
  let materializedRows = 0;
  let contentCells = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    materializedRows += 1;
    if (materializedRows > MAX_XLSX_MATERIALIZED_ROWS) {
      throw new BadRequestException('The first worksheet contains too many materialized rows');
    }
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (isBlankCell(cell)) return;
      contentCells += 1;
      if (contentCells > MAX_XLSX_CONTENT_CELLS) {
        throw new BadRequestException('The first worksheet contains too many populated cells');
      }
      if (columnNumber > 32) {
        throw new BadRequestException('Populated cells must appear within the first 32 columns');
      }
    });
    if (rowNumber === 1) return;

    const cells = {
      appShopId: row.getCell(columns.get('appShopId')!),
      shopId: row.getCell(columns.get('shopId')!),
      storeName: row.getCell(columns.get('storeName')!),
      coverage: row.getCell(columns.get('coverage')!),
    };
    if (Object.values(cells).every(isBlankCell)) return;
    if (stores.length >= MAX_STORES_PER_COMPLETION) {
      throw new BadRequestException(`A maximum of ${MAX_STORES_PER_COMPLETION} stores can be imported at once`);
    }

    stores.push({
      appShopId: plainCellText(cells.appShopId, 'appshopid', rowNumber, true),
      shopId: plainCellText(cells.shopId, 'shopid', rowNumber, true),
      storeName: plainCellText(cells.storeName, 'nombre de la tienda', rowNumber, false),
      coverage: plainCellText(cells.coverage, 'coverage', rowNumber, false),
    });
  });

  return parseCreateStoresCompletion({
    kind: CREATE_STORES_RESULT_KIND,
    version: 1,
    stores,
  });
}

export async function buildCreateStoresImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tequila 1.0';
  const sheet = workbook.addWorksheet('Tiendas creadas', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  sheet.columns = [
    { header: 'appshopid', key: 'appShopId', width: 28 },
    { header: 'shopid', key: 'shopId', width: 28 },
    { header: 'nombre de la tienda', key: 'storeName', width: 42 },
    { header: 'coverage', key: 'coverage', width: 36 },
  ];
  sheet.getColumn('appShopId').numFmt = '@';
  sheet.getColumn('shopId').numFmt = '@';
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6200' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.autoFilter = { from: 'A1', to: 'D1' };

  // Keep the importable sheet empty so a sample row can never be submitted
  // accidentally as a real store. The parser reads only the first worksheet.
  const example = workbook.addWorksheet('Ejemplo', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  example.columns = [
    { header: 'appshopid', key: 'appShopId', width: 28 },
    { header: 'shopid', key: 'shopId', width: 28 },
    { header: 'nombre de la tienda', key: 'storeName', width: 42 },
    { header: 'coverage', key: 'coverage', width: 36 },
  ];
  example.getColumn('appShopId').numFmt = '@';
  example.getColumn('shopId').numFmt = '@';
  example.addRow({
    appShopId: 'APP-0001',
    shopId: '5764607795237028465',
    storeName: 'Tienda Centro',
    coverage: 'Zona Centro',
  });
  const exampleHeader = example.getRow(1);
  exampleHeader.height = 24;
  exampleHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  exampleHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF64748B' } };
  exampleHeader.alignment = { vertical: 'middle', horizontal: 'center' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
