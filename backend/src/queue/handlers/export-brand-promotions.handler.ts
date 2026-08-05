import { Logger } from '@nestjs/common';
import { HandlerContext, registerHandler } from '../handler.processor';
import { writeMenuExport } from './menu-export.util';

const logger = new Logger('export_brand_promotions');

export async function exportBrandPromotions(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;
  if (!brand) throw new Error('Task has no brand linked');

  ctx.addNote(`Exporting the current promotions stored for ${brand.brandName}...`);
  let storedPromotions = 0;
  const exported = await writeMenuExport({
    prefix: 'brand-promotions',
    sheetName: 'Brand Promotions',
    columns: [
      { header: 'Brand ID', width: 24, text: true },
      { header: 'Brand', width: 28 },
      { header: 'Country', width: 12 },
      { header: 'Shop ID', width: 24, text: true },
      { header: 'App Shop ID', width: 24, text: true },
      { header: 'Store Name', width: 34 },
      { header: 'City', width: 24 },
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
      storedPromotions = await ctx.forEachBrandPromotionBatch(async promotions => {
        for (const promotion of promotions) {
          addRow([
            brand.brandId,
            brand.brandName,
            brand.country,
            promotion.shopId ?? '',
            promotion.shopExternalId,
            promotion.shopName ?? '',
            promotion.shopCity ?? '',
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
    ctx.addNote('No promotions are stored for this brand. Run the SFTP promotion reader and verify its SFTP account is linked to the brand.');
  } else {
    ctx.addNote(`Export completed: ${storedPromotions} promotion row(s).`);
  }
  logger.log(`Saved ${exported.filename} with ${storedPromotions} promotion row(s)`);
  return {
    fileKey: exported.filename,
    source: 'local_brand_promotions',
    totalPromotions: storedPromotions,
    brand: brand.brandName,
  };
}

registerHandler('export_brand_promotions', exportBrandPromotions);
