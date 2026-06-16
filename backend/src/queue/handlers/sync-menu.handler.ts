import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('sync_menu');

/**
 * Simulates syncing the brand's menu through the linked application.
 * In production this would call the DiDi Food API using brand.application.appSecret.
 *
 * Form fields used (optional):
 *  - "Menu URL"  (link)   — source URL for the menu to sync
 */
async function syncMenu(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;

  if (!brand) throw new Error('Task has no brand linked — cannot sync menu');

  const menuUrl = ctx.field('Menu URL');
  const appId = brand.application?.appId ?? 'no-app';

  logger.log(`Syncing menu for brand=${brand.brandName} (${brand.country}) app=${appId} menuUrl=${menuUrl ?? 'default'}`);

  // TODO: replace with real API call
  // const res = await fetch(`https://api.didi.com/menu/sync`, {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${brand.application?.appSecret}` },
  //   body: JSON.stringify({ appId, menuUrl }),
  // });
  // const data = await res.json();

  await new Promise((r) => setTimeout(r, 500)); // simulate network latency

  return {
    synced: true,
    brandId: brand.brandId,
    appId,
    menuUrl,
    syncedAt: new Date().toISOString(),
    itemsUpdated: 42, // mock
  };
}

registerHandler('sync_menu', syncMenu);
