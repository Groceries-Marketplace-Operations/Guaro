import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('enable_shop_online');

/**
 * Enables shops for the brand in DiDi Food (sets status to "online").
 * Uses shops from the task's select_store form field, or all brand shops if none selected.
 *
 * Form fields used (optional):
 *  - Any field of tipo "select_store" — specific shops to enable
 */
async function enableShopOnline(ctx: HandlerContext): Promise<unknown> {
  const { brand, formValues } = ctx;

  if (!brand) throw new Error('Task has no brand linked — cannot enable shops');

  // Collect shops explicitly selected via form, otherwise fall back to brand-level
  const selectedShops = formValues
    .filter((f) => f.tipo === 'select_store' && f.shop)
    .map((f) => f.shop!);

  logger.log(
    `Enabling ${selectedShops.length || 'all'} shops online for brand=${brand.brandName}`,
  );

  // TODO: call real API per shop
  // for (const shop of selectedShops) {
  //   await fetch(`https://api.didi.com/shops/${shop.appShopId}/enable`, { method: 'POST', ... });
  // }

  await new Promise((r) => setTimeout(r, 400));

  return {
    brandId: brand.brandId,
    shopsEnabled: selectedShops.length || 'all',
    enabledAt: new Date().toISOString(),
  };
}

registerHandler('enable_shop_online', enableShopOnline);
