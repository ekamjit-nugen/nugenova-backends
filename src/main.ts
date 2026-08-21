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
  const log = new Logger('Nexora');
  const app = await NestFactory.create(AppModule, { bodyParser: false });

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
  await app.listen(port);
  log.log(`🚀 Nexora backend on http://localhost:${port}/api/v1`);
  log.log(`📊 Health: http://localhost:${port}/api/v1/health`);
}

bootstrap().catch((err) => {
  console.error('Failed to start Nexora backend:', err);
  process.exit(1);
});
