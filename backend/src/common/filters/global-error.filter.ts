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

function getExceptionStatus(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();

  // Express/body-parser errors (including entity.too.large) are created before
  // Nest can wrap them in HttpException, but still expose a safe HTTP status.
  if (exception && typeof exception === 'object') {
    const error = exception as { status?: unknown; statusCode?: unknown };
    for (const candidate of [error.status, error.statusCode]) {
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
        return candidate;
      }
    }
  }

  return 500;
}

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalErrorFilter.name);

  constructor(private webhookSender: WebhookSenderService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const req    = ctx.getRequest<Request>();
    const res    = ctx.getResponse<Response>();

    const status = getExceptionStatus(exception);

    // Let the default handler deal with 4xx — only alert on server errors
    if (status < 500) {
      const body = exception instanceof HttpException
        ? exception.getResponse()
        : {
            statusCode: status,
            message: status === 413 ? 'Payload Too Large' : 'Bad Request',
          };
      res.status(status).json(body);
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    const stack   = exception instanceof Error ? (exception.stack ?? '') : '';

    const user = (req as any).user as { name?: string; email?: string; roles?: string[] } | undefined;
    const userLine = user
      ? `User:    ${user.name ?? '?'} <${user.email ?? '?'}> [${(user.roles ?? []).join(', ')}]`
      : `User:    unauthenticated`;

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
        userLine,
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
              `**User:** ${user ? `${user.name ?? '?'} \`${user.email ?? '?'}\` — roles: \`${(user.roles ?? []).join(', ')}\`` : 'unauthenticated'}`,
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
