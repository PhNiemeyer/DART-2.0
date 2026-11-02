import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './core/config';

export async function createApp(): Promise<INestApplication> {
  loadConfig();
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn'] });
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.disable('x-powered-by');
  http.set('trust proxy', 'loopback');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  // Uploads bis 20 MB (Base64 ≈ +34 %)
  app.use(express.json({ limit: '30mb' }));
  return app;
}

export function openApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('DART 2.0 API')
    .setDescription('Versionierte REST-API (v1) des DART-2.0-Prototyps. Fehlerantworten: { code, message (deutsch), request_id }. Nur synthetische Daten.')
    .setVersion('1.0.0-prototyp')
    .addCookieAuth('dart_session')
    .build();
  return SwaggerModule.createDocument(app, config);
}
