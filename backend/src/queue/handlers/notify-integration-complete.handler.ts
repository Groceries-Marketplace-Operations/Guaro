import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('notify_integration_complete');

/**
 * Sends a final notification (e.g. email / internal message) to confirm the
 * brand integration is complete.
 *
 * Form fields used (optional):
 *  - "Recipient Email"  (texto)  — override destination address
 *  - "Notes"            (texto)  — extra notes to include in the message
 */
async function notifyIntegrationComplete(ctx: HandlerContext): Promise<unknown> {
  const { brand } = ctx;

  if (!brand) throw new Error('Task has no brand linked');

  const recipientEmail = ctx.field('Recipient Email') ?? 'ops-team@didi-labs.com';
  const notes = ctx.field('Notes');

  logger.log(`Notifying ${recipientEmail} — integration complete for brand=${brand.brandName}`);

  // TODO: replace with real email / Slack / webhook call
  // await mailer.send({ to: recipientEmail, subject: `Brand ${brand.brandName} integrated`, ... });

  await new Promise((r) => setTimeout(r, 200));

  return {
    notified: true,
    recipient: recipientEmail,
    brand: brand.brandName,
    notes,
    notifiedAt: new Date().toISOString(),
  };
}

registerHandler('notify_integration_complete', notifyIntegrationComplete);
