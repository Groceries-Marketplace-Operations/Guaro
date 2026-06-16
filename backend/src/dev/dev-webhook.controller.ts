import { Body, Controller, Delete, Get, Post } from '@nestjs/common';

interface WebhookEntry {
  receivedAt: string;
  payload: unknown;
}

// In-memory ring buffer — last 50 payloads
const LOG: WebhookEntry[] = [];
const MAX = 50;

/**
 * Dev-only webhook receiver.
 *
 * Configure step webhooks to point at:
 *   http://localhost:3000/dev/webhook-log
 *
 * Then inspect what was received:
 *   GET  http://localhost:3000/dev/webhook-log
 *   DELETE http://localhost:3000/dev/webhook-log  (clear)
 */
@Controller('dev/webhook-log')
export class DevWebhookController {
  @Post()
  receive(@Body() body: unknown) {
    LOG.unshift({ receivedAt: new Date().toISOString(), payload: body });
    if (LOG.length > MAX) LOG.length = MAX;
    return { ok: true };
  }

  @Get()
  list() {
    return LOG;
  }

  @Delete()
  clear() {
    LOG.length = 0;
    return { ok: true, cleared: true };
  }
}
