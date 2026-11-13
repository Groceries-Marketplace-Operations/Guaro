import { sleep } from '../queue/handlers/didi-food.util';

// DiDi permits one stock request per shop per minute. Redis keeps this limit
// shared by all auto-turn-off workers, including workers in another process.
export const STOCK_REQUEST_COOLDOWN_MS = 61_000;

export interface StockRateLimitStore {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  runCommand(name: string, args: string[]): Promise<unknown>;
}

const registeredStores = new WeakSet<StockRateLimitStore>();

export async function waitForShopStockSlot(
  store: StockRateLimitStore,
  appId: string,
  appShopId: string,
  ensureActive: () => Promise<void>,
  pause: (ms: number) => Promise<void> = sleep,
) {
  if (!registeredStores.has(store)) {
    store.defineCommand('reserveAutoTurnOffStockSlot', {
      numberOfKeys: 1,
      lua: `
        local ttl = redis.call('PTTL', KEYS[1])
        if ttl > 0 then return ttl end
        redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
        return 0
      `,
    });
    registeredStores.add(store);
  }
  const key = `auto-turn-off:stock:${appId}:${appShopId}`;
  while (true) {
    await ensureActive();
    const ttl = Number(await store.runCommand('reserveAutoTurnOffStockSlot', [key, String(STOCK_REQUEST_COOLDOWN_MS)]));
    if (ttl === 0) return;
    if (!Number.isFinite(ttl)) throw new Error('Stock rate limiter returned an invalid delay');
    await pause(Math.max(250, Math.min(ttl > 0 ? ttl : 250, 5_000)));
  }
}
