import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('validate_app_credentials');

/**
 * Validates that the brand's linked application credentials are active.
 * In production this would hit the DiDi auth endpoint with the decrypted appSecret.
 */
async function validateAppCredentials(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;

  if (!brand) throw new Error('Task has no brand linked — cannot validate credentials');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no linked application`);

  const { appId, appSecret } = brand.application;

  logger.log(`Validating credentials for brand=${brand.brandName} appId=${appId}`);

  // TODO: replace with real validation call
  // const res = await fetch(`https://api.didi.com/auth/validate`, {
  //   headers: { 'x-app-id': appId, Authorization: `Bearer ${appSecret}` },
  // });
  // if (!res.ok) throw new Error(`Credential validation failed: ${res.status}`);
  // const data = await res.json();

  await new Promise((r) => setTimeout(r, 300));

  const valid = appSecret.length > 0; // trivial mock: non-empty secret = valid

  if (!valid) throw new Error('Application credentials are invalid or expired');

  return {
    valid: true,
    appId,
    checkedAt: new Date().toISOString(),
  };
}

registerHandler('validate_app_credentials', validateAppCredentials);
