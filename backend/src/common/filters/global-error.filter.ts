import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WebhookSenderService } from '../../webhooks/webhook-sender.service';

const ERRORS_DIR = join(process.cwd(), 'uploads', 'errors');

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalErrorFilter.name);

  constructor(private webhookSender: WebhookSenderService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const req    = ctx.getRequest<Request>();
    const res    = ctx.getResponse<Response>();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;

    // Let the default handler deal with 4xx — only alert on server errors
    if (status < 500) {
      const body = exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Error' };
      res.status(status).json(body);
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    const stack   = exception instanceof Error ? (exception.stack ?? '') : '';

    // ── Write error log file ─────────────────────────────────────────────────
    const errorId  = randomBytes(4).toString('hex');
    const dateStr  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${dateStr}_${errorId}.log`;

    try {
      if (!existsSync(ERRORS_DIR)) mkdirSync(ERRORS_DIR, { recursive: true });

      const content = [
        `Date:    ${new Date().toISOString()}`,
        `Route:   ${req.method} ${req.url}`,
        `Status:  ${status}`,
        `Message: ${message}`,
        '',
        '── Stack ──────────────────────────────────────────────────────────────',
        stack,
      ].join('\n');

      writeFileSync(join(ERRORS_DIR, fileName), content, 'utf8');
    } catch (fsErr) {
      this.logger.error(`Failed to write error log: ${(fsErr as Error).message}`);
    }

    // ── Send webhook alert ───────────────────────────────────────────────────
    try {
      await this.webhookSender.sendAlert({
        text: `🚨 **Server Error 500** — \`${req.method} ${req.url}\``,
        attachments: [
          {
            title: 'Error details',
            text: [
              `**Message:** ${message.slice(0, 300)}${message.length > 300 ? '…' : ''}`,
              `**Log file:** \`${fileName}\``,
              `\`docker exec guaro-backend-1 cat /app/uploads/errors/${fileName}\``,
            ].join('\n'),
            color: '#F44336',
          },
        ],
      });
    } catch (webhookErr) {
      this.logger.error(`Failed to send error webhook: ${(webhookErr as Error).message}`);
    }

    this.logger.error(`${req.method} ${req.url} → ${status}: ${message}`);

    res.status(status).json({ statusCode: status, message: 'Internal server error' });
  }
}
