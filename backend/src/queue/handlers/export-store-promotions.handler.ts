import { Logger } from '@nestjs/common';
import { HandlerContext, registerHandler } from '../handler.processor';
import { writeMenuExport } from './menu-export.util';

const logger = new Logger('export_store_promotions');

export async function exportStorePromotions(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand) throw new Error('Task has no brand linked');
  const selectedShop = ctx.formValues.find(value => value.tipo === 'select_store' && value.shop)?.shop;
  if (!selectedShop) throw new Error('Select one store to export its promotions');
  if (selectedShop.brandId !== brand.id) {
    throw new Error(`Store ${selectedShop.shopId} does not belong to brand ${brand.brandName}`);
  }

  ctx.addNote(`Exporting locally stored promotions for ${selectedShop.shopId} (${selectedShop.appShopId})...`);
  let storedPromotions = 0;
  const exported = await writeMenuExport({
    prefix: 'store-promotions',
    sheetName: 'Store Promotions',
    columns: [
      { header: 'Shop ID', width: 24, text: true },
      { header: 'App Shop ID', width: 24, text: true },
      { header: 'Brand', width: 28 },
      { header: 'SFTP Account', width: 30 },
      { header: 'Activity ID', width: 24, text: true },
      { header: 'Activity Name', width: 45 },
      { header: 'Start Date', width: 22, text: true },
      { header: 'End Date', width: 22, text: true },
      { header: 'Activity Type', width: 16 },
      { header: 'SKU / UPC', width: 24, text: true },
      { header: 'Discount Amount', width: 20, text: true },
      { header: 'Discount Percentage', width: 22, text: true },
      { header: 'Buy Num', width: 14, text: true },
      { header: 'Get Num', width: 14, text: true },
      { header: 'BXGY X', width: 14, text: true },
      { header: 'BXGY Y / Final Price', width: 24, text: true },
      { header: 'Action Type', width: 16 },
      { header: 'Source File', width: 42, text: true },
      { header: 'Fetched At', width: 24 },
    ],
    populate: async (addRow) => {
      storedPromotions = await ctx.forEachStorePromotionBatch(selectedShop.appShopId, async promotions => {
        for (const promotion of promotions) {
          addRow([
            selectedShop.shopId,
            selectedShop.appShopId,
            brand.brandName,
            promotion.sourceAccount,
            promotion.activityId,
            promotion.activityName ?? '',
            promotion.startDate ?? '',
            promotion.endDate ?? '',
            promotion.activityType ?? '',
            promotion.sku,
            promotion.discountAmount ?? '',
            promotion.discountPercentage ?? '',
            promotion.buyNum ?? '',
            promotion.getNum ?? '',
            promotion.bxgyX ?? '',
            promotion.bxgyY ?? '',
            promotion.actionType ?? '',
            promotion.sourceFile,
            promotion.fetchedAt.toISOString(),
          ]);
        }
      });
    },
  });
  if (storedPromotions === 0) {
    ctx.addNote('No promotions are stored for this App Shop ID. Run the SFTP promotion reader first and verify the SFTP account is linked to the brand.');
  } else {
    ctx.addNote(`Export completed: ${storedPromotions} promotion item row(s).`);
  }
  logger.log(`Saved ${exported.filename} with ${storedPromotions} promotion row(s)`);
  return {
    fileKey: exported.filename,
    source: 'local_store_promotions',
    shopId: selectedShop.shopId,
    appShopId: selectedShop.appShopId,
    totalPromotions: storedPromotions,
    brand: brand.brandName,
  };
}

registerHandler('export_store_promotions', exportStorePromotions);
