import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('debug_echo');

/**
 * Test handler — does nothing real but proves the full pipeline works:
 *   • receives HandlerContext (form values, brand, appSecret decrypted)
 *   • logs everything to the Nest console
 *   • returns the context as the step result (visible in TaskDetail)
 *   • WebhookSender fires on_start (from activateStep) and on_complete (from completeStep)
 *     → check GET /dev/webhook-log to see both payloads
 */
async function debugEcho(ctx: HandlerContext): Promise<unknown> {
  logger.log('=== debug_echo fired ===');
  logger.log(`  taskId:        ${ctx.taskId}`);
  logger.log(`  stepId:        ${ctx.stepInstanceId}`);
  logger.log(`  brand:         ${ctx.brand?.brandName ?? '(none)'} [${ctx.brand?.country ?? ''}]`);
  logger.log(`  appId:         ${ctx.brand?.application?.appId ?? '(no app)'}`);
  logger.log(`  formValues:    ${JSON.stringify(ctx.formValues)}`);

  // Simulate a tiny bit of async work
  await new Promise((r) => setTimeout(r, 300));

  logger.log('=== debug_echo done ===');

  return {
    echo: true,
    taskId: ctx.taskId,
    brand: ctx.brand?.brandName ?? null,
    country: ctx.brand?.country ?? null,
    appId: ctx.brand?.application?.appId ?? null,
    formValues: ctx.formValues.map((f) => ({ label: f.label, valor: f.valor })),
    completedAt: new Date().toISOString(),
  };
}

registerHandler('debug_echo', debugEcho);
