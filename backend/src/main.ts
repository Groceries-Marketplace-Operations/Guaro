import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { AppModule } from './app.module';
import { GlobalErrorFilter } from './common/filters/global-error.filter';
import { enableSystemCertificateAuthorities } from './common/system-ca.util';
import { WebhookSenderService } from './webhooks/webhook-sender.service';

async function bootstrap() {
  const systemCertificateCount = enableSystemCertificateAuthorities();
  if (systemCertificateCount > 0) {
    console.log(`TLS: ${systemCertificateCount} system certificate authorities enabled`);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // A 7,000-store binding job is larger than Express' 100 KB default. Keep
  // this bounded: DTO validation still enforces the exact 7,000-item limit.
  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '100kb' });

  // Static downloads need CORS when frontend and backend use different origins.
  app.enableCors();

  // Serve uploaded template files as static assets
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  const webhookSender = app.get(WebhookSenderService);
  app.useGlobalFilters(new GlobalErrorFilter(webhookSender));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend corriendo en http://localhost:${port}`);
}

bootstrap();
