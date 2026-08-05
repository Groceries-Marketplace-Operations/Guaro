import { Logger } from '@nestjs/common';
import { downloadMenu } from '../../integrations/auto-turn-off-api.util';
import { HandlerContext, registerHandler } from '../handler.processor';
import { getAuthToken } from './didi-food.util';
import { MenuExportCell, MenuExportColumn, writeMenuExport } from './menu-export.util';

const logger = new Logger('export_store_menu');

const EXCEL_CELL_TEXT_LIMIT = 32_767;

function flattenItem(
  value: Record<string, unknown>,
  prefix = '',
  result: Record<string, MenuExportCell> = {},
): Record<string, MenuExportCell> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flattenItem(child as Record<string, unknown>, path, result);
      continue;
    }
    if (child === undefined || child === null) {
      result[path] = null;
    } else if (typeof child === 'object') {
      const serialized = JSON.stringify(child);
      result[path] = serialized.length <= EXCEL_CELL_TEXT_LIMIT
        ? serialized
        : '[Value exceeds the Excel cell limit; see Raw API JSON sheet]';
    } else {
      result[path] = String(child);
    }
  }
  return result;
}

function orderedItemFields(items: Array<Record<string, MenuExportCell>>): string[] {
  const fields = new Set(items.flatMap(item => Object.keys(item)));
  const preferred = ['app_item_id', 'upc', 'name', 'item_name', 'status', 'price'];
  return [...fields].sort((left, right) => {
    const leftRank = preferred.indexOf(left);
    const rightRank = preferred.indexOf(right);
    if (leftRank >= 0 || rightRank >= 0) {
      if (leftRank < 0) return 1;
      if (rightRank < 0) return -1;
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

function columnForField(field: string): MenuExportColumn {
  const lower = field.toLowerCase();
  const width = lower.includes('name') || lower.includes('description')
    ? 40
    : lower.includes('url') || lower.includes('image') || lower.includes('picture')
      ? 36
      : 22;
  return { header: field, width, text: true };
}

export async function exportStoreMenu(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand) throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const selectedShop = ctx.formValues.find(value => value.tipo === 'select_store' && value.shop)?.shop;
  if (!selectedShop) throw new Error('Select one store to export its menu');
  if (selectedShop.brandId !== brand.id) {
    throw new Error(`Store ${selectedShop.shopId} does not belong to brand ${brand.brandName}`);
  }

  ctx.addNote(`Requesting the current menu for store ${selectedShop.shopId} (${selectedShop.appShopId})...`);
  const authToken = await getAuthToken(
    brand.application.appId,
    brand.application.appSecret,
    selectedShop.appShopId,
  );
  const downloaded = await downloadMenu(authToken, async () => undefined);
  const items = downloaded.items.map(item => flattenItem(item));
  const itemFields = orderedItemFields(items);
  if (itemFields.length + 4 > 16_384) {
    throw new Error(`Menu contains ${itemFields.length} item fields, exceeding the Excel column limit`);
  }
  ctx.addNote(
    `DiDi menu export completed in ${(downloaded.elapsedMs / 60_000).toFixed(2)} minute(s) `
    + `after ${downloaded.pollAttempts} status poll(s).`,
  );
  ctx.addNote(`${downloaded.items.length} item(s) and ${itemFields.length} API field(s) will be exported without normalization.`);

  const exported = await writeMenuExport({
    prefix: 'store-menu',
    sheetName: 'Store Menu',
    columns: [
      { header: 'Shop ID', width: 24, text: true },
      { header: 'App Shop ID', width: 24, text: true },
      { header: 'Brand', width: 28 },
      { header: 'Country', width: 12 },
      ...itemFields.map(columnForField),
    ],
    populate: async (addRow) => {
      for (const item of items) {
        addRow([
          selectedShop.shopId,
          selectedShop.appShopId,
          brand.brandName,
          brand.country,
          ...itemFields.map(field => item[field] ?? null),
        ]);
      }
    },
    rawJson: downloaded.rawJson,
  });

  logger.log(`Saved ${exported.filename} with ${exported.rowCount} item(s)`);
  ctx.addNote(`Export completed: ${exported.rowCount} item(s).`);
  return {
    fileKey: exported.filename,
    jsonFileKey: exported.jsonFilename,
    source: 'remote_store_menu',
    menuTaskId: downloaded.taskId,
    menuElapsedMs: downloaded.elapsedMs,
    menuPollAttempts: downloaded.pollAttempts,
    shopId: selectedShop.shopId,
    appShopId: selectedShop.appShopId,
    totalItems: exported.rowCount,
    exportedFields: itemFields.length,
    rawJsonIncluded: true,
    brand: brand.brandName,
  };
}

registerHandler('export_store_menu', exportStoreMenu);
