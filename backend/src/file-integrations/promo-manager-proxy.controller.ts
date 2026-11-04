import { All, BadRequestException, Controller, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AccountRole } from '@prisma/client';
import { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

@Controller('promo-manager')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AccountRole.admin, AccountRole.super_admin)
export class PromoManagerProxyController {
  @All('*')
  async proxy(@Req() request: Request, @Res() response: Response) {
    const suffix = request.path.slice('/promo-manager'.length);
    const query = request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : '';
    const upstreamUrl = `http://promo-manager:5373/api${suffix}${query}`;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : (request as Request & { rawBody?: Buffer }).rawBody;
    if (hasBody && !body && Number(request.headers['content-length'] ?? 0) > 0) {
      throw new BadRequestException('El cuerpo de la solicitud debe ser JSON.');
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: {
          ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}),
          accept: request.headers.accept ?? '*/*',
        },
        body: hasBody ? body?.toString('utf8') : undefined,
        signal: AbortSignal.timeout(3_600_000),
      });
    } catch {
      throw new ServiceUnavailableException('El gestor de promociones no está disponible.');
    }

    response.status(upstream.status);
    for (const header of ['content-type', 'content-disposition', 'content-length', 'x-content-type-options']) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }
    response.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) return response.end();
    try {
      await pipeline(Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream), response);
    } catch (error) {
      if (!response.destroyed) throw error;
    }
  }
}
