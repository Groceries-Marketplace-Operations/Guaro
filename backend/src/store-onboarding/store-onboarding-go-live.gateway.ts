import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decrypt } from '../common/crypto.util';
import {
  DIDI_BASE,
  fetchWithEndpointContext,
  getAuthToken,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

export type StoreOnboardingGoLiveInput = {
  appId: string;
  encryptedAppSecret: string;
  appShopId: string;
};

export class StoreOnboardingRemoteOfflineError extends Error {
  readonly code = 'STORE_ONBOARDING_REMOTE_OFFLINE';

  constructor(readonly remoteBizStatus: number | null) {
    super('Remote verification did not confirm the store as online');
    this.name = 'StoreOnboardingRemoteOfflineError';
  }
}

/** The remote endpoint answered definitively that setStatus was rejected. */
export class StoreOnboardingRemoteRejectedError extends Error {
  readonly code = 'STORE_ONBOARDING_REMOTE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'StoreOnboardingRemoteRejectedError';
  }
}

/**
 * The setStatus request may have reached the provider, but its final outcome
 * is unknown. Callers must never repeat the write; recovery is verify-only.
 */
export class StoreOnboardingAmbiguousGoLiveError extends Error {
  readonly code = 'STORE_ONBOARDING_AMBIGUOUS_GO_LIVE';

  constructor(message: string) {
    super(message);
    this.name = 'StoreOnboardingAmbiguousGoLiveError';
  }
}

@Injectable()
export class StoreOnboardingGoLiveGateway {
  constructor(private readonly config: ConfigService) {}

  async open(input: StoreOnboardingGoLiveInput) {
    let postMayHaveBeenSent = false;
    try {
      return await this.withTimeout(async signal => {
        const authToken = await this.authenticate(input);
        const endpoint = 'POST /v1/shop/shop/setStatus';
        postMayHaveBeenSent = true;
        const response = await fetchWithEndpointContext(endpoint, `${DIDI_BASE}/v1/shop/shop/setStatus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_token: authToken, biz_status: 1, auto_switch: 1 }),
          signal,
        });
        const body = parseJsonKeepingIds(await response.text());
        if (!response.ok) {
          const ambiguousStatus = response.status === 408
            || response.status === 425
            || response.status === 429
            || response.status >= 500;
          const message = `${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`;
          if (ambiguousStatus) {
            throw new StoreOnboardingAmbiguousGoLiveError(
              `${message}; setStatus may have been applied and recovery must verify without repeating it`,
            );
          }
          throw new StoreOnboardingRemoteRejectedError(message);
        }
        if (body.errno !== 0) {
          throw new StoreOnboardingRemoteRejectedError(
            `${endpoint} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`,
          );
        }
        try {
          const remoteBizStatus = await this.verifyWithToken(authToken, signal);
          return { endpoint, remoteBizStatus, response: body };
        } catch (error) {
          if (error instanceof StoreOnboardingRemoteOfflineError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new StoreOnboardingAmbiguousGoLiveError(
            `setStatus was accepted but online verification is pending: ${message}`,
          );
        }
      });
    } catch (error) {
      if (
        error instanceof StoreOnboardingRemoteOfflineError
        || error instanceof StoreOnboardingRemoteRejectedError
        || error instanceof StoreOnboardingAmbiguousGoLiveError
      ) throw error;
      if (!postMayHaveBeenSent) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new StoreOnboardingAmbiguousGoLiveError(
        `setStatus outcome is unknown; recovery will verify without repeating it: ${message}`,
      );
    }
  }

  /** Read-only recovery path for an attempt left going_online after a crash. */
  async verify(input: StoreOnboardingGoLiveInput) {
    return this.withTimeout(async signal => {
      const authToken = await this.authenticate(input);
      const remoteBizStatus = await this.verifyWithToken(authToken, signal);
      return { endpoint: 'GET /v1/shop/shop/detail', remoteBizStatus, response: { verified: true } };
    });
  }

  private async authenticate(input: StoreOnboardingGoLiveInput) {
    if (!input.appShopId.trim()) throw new BadRequestException('app_shop_id is required for Go-Live');
    let appSecret: string;
    try {
      const key = this.config.get<string>('APP_SECRET_ENCRYPTION_KEY') ?? '';
      appSecret = key ? decrypt(input.encryptedAppSecret, key) : input.encryptedAppSecret;
    } catch {
      throw new BadRequestException('Application credential could not be decrypted');
    }
    return getAuthToken(input.appId, appSecret, input.appShopId);
  }

  private async verifyWithToken(authToken: string, signal: AbortSignal) {
    let remoteBizStatus: number | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1_000));
      const detailEndpoint = 'GET /v1/shop/shop/detail';
      const detailResponse = await fetchWithEndpointContext(
        detailEndpoint,
        `${DIDI_BASE}/v1/shop/shop/detail?auth_token=${encodeURIComponent(authToken)}`,
        { signal },
      );
      const detail = parseJsonKeepingIds(await detailResponse.text());
      if (!detailResponse.ok || detail.errno !== 0) {
        throw new Error(`${detailEndpoint} failed: ${detail.errmsg ?? `HTTP ${detailResponse.status}`} (errno=${detail.errno ?? 'unknown'})`);
      }
      const raw = detail.data?.biz_status ?? detail.data?.bizStatus;
      remoteBizStatus = raw === true ? 1 : raw === false ? 2 : Number(raw);
      if (remoteBizStatus === 1) break;
    }
    if (remoteBizStatus !== 1) {
      throw new StoreOnboardingRemoteOfflineError(remoteBizStatus);
    }
    return remoteBizStatus;
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutMs = 20_000;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Go-Live gateway timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
