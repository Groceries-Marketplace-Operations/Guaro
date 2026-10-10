import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const STOCK_BATCH_SIZE = 2000;
export const STOCK_INTERVAL_MS = 60_000;

@Injectable()
export class SftpApiStockLimiter {
  constructor(@InjectQueue('sftp-api') private readonly queue: Queue) {}

  async acquire(appId: string, shopId: string, ensureRunning: () => Promise<void>) {
    const redis = await this.queue.client;
    redis.defineCommand('sftpStockAcquire', { numberOfKeys: 1,
      lua: "return redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')" });
    redis.defineCommand('sftpStockCooldown', { numberOfKeys: 1,
      lua: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0" });
    const key = `sftp-api:stock-sync:${JSON.stringify([appId, shopId])}`;
    const owner = randomUUID();
    // Cover the 60s HTTP timeout plus a full cooldown if the worker disappears.
    while (true) {
      await ensureRunning();
      if (await redis.runCommand('sftpStockAcquire', [key, owner, 120_000])) break;
      await this.wait(1000);
    }
    return async () => {
      // Keep the cooldown after completion, including failures. Never release a
      // newer worker's lease. Redis shares the limit across runs and processes.
      await redis.runCommand('sftpStockCooldown', [key, owner, STOCK_INTERVAL_MS]);
    };
  }

  protected async wait(ms: number) { await sleep(ms); }
}
