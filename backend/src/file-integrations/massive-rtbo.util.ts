import {
  DIDI_BASE,
  fetchWithEndpointContext,
  parseJsonKeepingIds,
} from '../queue/handlers/didi-food.util';

export const MASSIVE_RTBO_ENDPOINT = 'POST /v1/shop/shop/update';

export async function updatePromiseProduceTime(authToken: string, promiseProduceTime: number) {
  const response = await fetchWithEndpointContext(
    MASSIVE_RTBO_ENDPOINT,
    `${DIDI_BASE}/v1/shop/shop/update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: authToken,
        promise_produce_time: promiseProduceTime,
      }),
    },
  );
  const body = parseJsonKeepingIds(await response.text());
  if (!response.ok || body.errno !== 0) {
    throw new Error(
      `${MASSIVE_RTBO_ENDPOINT} failed: ${body.errmsg ?? `HTTP ${response.status}`} (errno=${body.errno ?? 'unknown'})`,
    );
  }
  return body.data ?? {};
}
