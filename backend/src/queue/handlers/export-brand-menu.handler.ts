import { Logger } from '@nestjs/common';
import { HandlerContext, registerHandler } from '../handler.processor';
import { writeMenuExport } from './menu-export.util';

const logger = new Logger('export_brand_menu');

export async function exportBrandMenu(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand) throw new Error('Task has no brand linked');

  ctx.addNote(`Exporting the local catalog stored for ${brand.brandName}...`);
  let storedItems = 0;
  const exported = await writeMenuExport({
    prefix: 'brand-menu',
    sheetName: 'Local Brand Menu',
    columns: [
      { header: 'Brand ID', width: 24, text: true },
      { header: 'Brand', width: 28 },
      { header: 'Country', width: 12 },
      { header: 'Item Name', width: 45 },
      { header: 'UPC', width: 22, text: true },
      { header: 'App Item ID', width: 28, text: true },
      { header: 'Image URL', width: 48, text: true },
      { header: 'Source Shop ID', width: 24, text: true },
      { header: 'Source City', width: 24 },
      { header: 'Last Seen At', width: 24 },
    ],
    populate: async (addRow) => {
      storedItems = await ctx.forEachBrandItemBatch(async (items) => {
        for (const item of items) {
          addRow([
            brand.brandId,
            brand.brandName,
            brand.country,
            item.name,
            item.upc ?? '',
            item.appItemId,
            item.imageUrl ?? '',
            item.sourceShopId ?? '',
            item.sourceCity ?? '',
            item.lastSeenAt.toISOString(),
          ]);
        }
      });
    },
  });

  logger.log(`Saved ${exported.filename} with ${exported.rowCount} local item(s)`);
  ctx.addNote(`Export completed: ${exported.rowCount} local item(s).`);
  return {
    fileKey: exported.filename,
    source: 'local_brand_catalog',
    totalItems: exported.rowCount,
    storedItems,
    brand: brand.brandName,
  };
}

registerHandler('export_brand_menu', exportBrandMenu);
