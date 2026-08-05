import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import * as Exceljs from 'exceljs';

export type MenuExportCell = string | number | Date | null;

export interface MenuExportColumn {
  header: string;
  width: number;
  text?: boolean;
}

interface WriteMenuExportOptions {
  prefix: 'store-menu' | 'brand-menu' | 'store-promotions' | 'brand-promotions';
  sheetName: string;
  columns: MenuExportColumn[];
  populate: (addRow: (values: MenuExportCell[]) => void) => Promise<void>;
  /** Exact source response. It is saved as JSON and embedded losslessly in a second worksheet. */
  rawJson?: string;
}

const EXCEL_CELL_TEXT_LIMIT = 32_767;
const RAW_JSON_CHUNK_SIZE = 30_000;

function styleHeader(row: Exceljs.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
  row.alignment = { vertical: 'middle' };
  row.commit();
}

/**
 * Writes exports with ExcelJS's streaming writer so large brand catalogs do not
 * have to be retained twice in memory while the XLSX file is assembled.
 */
export async function writeMenuExport(options: WriteMenuExportOptions) {
  const exportsDir = join(process.cwd(), 'uploads', 'exports');
  await mkdir(exportsDir, { recursive: true });
  const exportId = randomUUID();
  const filename = `${options.prefix}-${exportId}.xlsx`;
  const jsonFilename = options.rawJson ? `${options.prefix}-${exportId}.json` : undefined;
  const filepath = join(exportsDir, filename);
  const jsonFilepath = jsonFilename ? join(exportsDir, jsonFilename) : undefined;

  const workbook = new Exceljs.stream.xlsx.WorkbookWriter({
    filename: filepath,
    useStyles: true,
    useSharedStrings: false,
  });
  const worksheet = workbook.addWorksheet(options.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  worksheet.columns = options.columns.map((column, index) => ({
    key: `column_${index + 1}`,
    header: column.header,
    width: column.width,
    ...(column.text ? { style: { numFmt: '@' } } : {}),
  }));

  styleHeader(worksheet.getRow(1));

  let rowCount = 0;
  try {
    await options.populate((values) => {
      worksheet.addRow(values).commit();
      rowCount += 1;
    });
    worksheet.commit();

    if (options.rawJson !== undefined) {
      const rawSheet = workbook.addWorksheet('Raw API JSON', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      rawSheet.columns = [
        { key: 'chunk', header: 'Chunk', width: 12 },
        { key: 'json', header: 'Raw API JSON', width: 120, style: { numFmt: '@' } },
      ];
      styleHeader(rawSheet.getRow(1));
      for (let offset = 0, chunk = 1; offset < options.rawJson.length; offset += RAW_JSON_CHUNK_SIZE, chunk++) {
        const value = options.rawJson.slice(offset, offset + RAW_JSON_CHUNK_SIZE);
        if (value.length > EXCEL_CELL_TEXT_LIMIT) throw new Error('Raw JSON chunk exceeds the Excel cell limit');
        rawSheet.addRow([chunk, value]).commit();
      }
      rawSheet.commit();
    }

    await workbook.commit();
    if (jsonFilepath && options.rawJson !== undefined) {
      await writeFile(jsonFilepath, options.rawJson, 'utf8');
    }
    return { filename, jsonFilename, rowCount };
  } catch (error) {
    await unlink(filepath).catch(() => undefined);
    if (jsonFilepath) await unlink(jsonFilepath).catch(() => undefined);
    throw error;
  }
}
