import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { COOLDOWN_SHOPLIST_MS, sleep } from '../queue/handlers/didi-food.util';

/**
 * Serializes synchronous and durable DiDi binding work in this process.
 * The database partial unique index independently prevents two durable runs
 * for the same Application across processes.
 */
@Injectable()
export class DidiStoreBindingCoordinator {
  private readonly activeApplications = new Set<string>();
  private readonly shopListTails = new Map<string, Promise<void>>();
  private readonly lastShopListStartedAt = new Map<string, number>();
  private readonly shopListCooldownMs: number;

  constructor(@Optional() config?: ConfigService) {
    const configured = Number(config?.get(
      'DIDI_STORE_BINDINGS_SHOP_LIST_COOLDOWN_MS',
      String(COOLDOWN_SHOPLIST_MS),
    ) ?? COOLDOWN_SHOPLIST_MS);
    const minimum = config instanceof ConfigService ? COOLDOWN_SHOPLIST_MS : 1;
    this.shopListCooldownMs = Number.isFinite(configured) && configured >= minimum
      ? configured
      : COOLDOWN_SHOPLIST_MS;
  }

  async withLock<T>(applicationId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeApplications.has(applicationId)) {
      throw new ConflictException('Another DiDi bind/unbind operation is already running for this application');
    }
    this.activeApplications.add(applicationId);
    try {
      return await operation();
    } finally {
      this.activeApplications.delete(applicationId);
    }
  }

  /** Serializes and rate-limits real provider shop-list calls per Application. */
  async withShopListRateLimit<T>(applicationId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.shopListTails.get(applicationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.shopListTails.set(applicationId, tail);
    await predecessor.catch(() => undefined);
    try {
      const elapsed = Date.now() - (this.lastShopListStartedAt.get(applicationId) ?? 0);
      if (elapsed < this.shopListCooldownMs) await sleep(this.shopListCooldownMs - elapsed);
      this.lastShopListStartedAt.set(applicationId, Date.now());
      return await operation();
    } finally {
      release();
      if (this.shopListTails.get(applicationId) === tail) this.shopListTails.delete(applicationId);
    }
  }
}
