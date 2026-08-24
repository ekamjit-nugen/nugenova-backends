import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const log = new Logger('Nugenova');
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Behind the nginx reverse proxy in production: trust the first proxy hop so
  // req.ip / X-Forwarded-For reflect the real client (used for signature capture
  // and OTP rate-limiting), and secure cookies work over the proxied TLS.
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);

  const bodyLimit = process.env.BODY_LIMIT || '10mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  app.use(cookieParser());
  app.use(helmet());

  const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => (!origin || origins.includes(origin) ? cb(null, true) : cb(new Error(`Origin ${origin} not allowed`), false)),
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.setGlobalPrefix('api/v1');

  const port = Number(process.env.PORT || 4000);
  // In production bind to 127.0.0.1 (HOST) so only nginx can reach the app; the
  // default 0.0.0.0 keeps local dev reachable.
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  log.log(`🚀 Nugenova backend on http://${host}:${port}/api/v1`);
  log.log(`📊 Health: http://localhost:${port}/api/v1/health`);
}

bootstrap().catch((err) => {
  console.error('Failed to start Nugenova backend:', err);
  process.exit(1);
});
