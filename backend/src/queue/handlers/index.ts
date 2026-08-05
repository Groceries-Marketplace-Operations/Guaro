/**
 * Handler registry — import every concrete handler here so they self-register
 * when queue.module.ts loads this file.
 */
export * from './sync-menu.handler';
export * from './validate-app-credentials.handler';
export * from './enable-shop-online.handler';
export * from './notify-integration-complete.handler';
export * from './debug-echo.handler';
export * from './schedule-update-permanent.handler';
export * from './schedule-update-dates.handler';
export * from './menu-upload.handler';
export * from './stock-update.handler';
export * from './export-shop-list.handler';
export * from './export-store-menu.handler';
export * from './export-brand-menu.handler';
export * from './export-store-promotions.handler';
export * from './export-brand-promotions.handler';
