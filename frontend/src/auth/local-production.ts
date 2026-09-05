export const isLocalProductionMode = import.meta.env.GUARO_LOCAL_PRODUCTION === 'true';
export const localProductionSessionExpiresAt = import.meta.env.GUARO_LOCAL_PRODUCTION_EXPIRES_AT;

const LOCAL_PRODUCTION_NONCE_HEADER = 'X-Guaro-Local-Session';

export function localProductionRequestHeaders(): Record<string, string> {
  if (!isLocalProductionMode) return {};
  return { [LOCAL_PRODUCTION_NONCE_HEADER]: import.meta.env.GUARO_LOCAL_PRODUCTION_NONCE };
}

export async function stopLocalProductionSession() {
  if (!isLocalProductionMode) return;
  await fetch(`${import.meta.env.BASE_URL}__local-production/stop`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: localProductionRequestHeaders(),
  });
}
