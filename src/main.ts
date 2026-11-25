import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { EnvConfig } from './config/env.validation.js';
import { registerLocalTestConsole } from './test-console.util.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  const config = app.get(ConfigService<EnvConfig, true>);
  const appEnv = config.get('APP_ENV', { infer: true });
  const isProd = appEnv === 'production';
  const isLocal = appEnv === 'local';

  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  if (trustProxy !== undefined) {
    const normalized = trustProxy.toLowerCase();
    if (normalized === 'true') {
      app.set('trust proxy', true);
    } else if (normalized === 'false') {
      app.set('trust proxy', false);
    } else if (/^\d+$/.test(normalized)) {
      app.set('trust proxy', Number(normalized));
    } else {
      app.set('trust proxy', trustProxy);
    }
  }

  app.useLogger(
    new ConsoleLogger({
      json: isProd,
      logLevels: isProd
        ? ['log', 'warn', 'error', 'fatal']
        : ['log', 'warn', 'error', 'fatal', 'debug'],
      redact: ['password', 'authorization', 'x-internal-api-key'],
    }),
  );
  app.enableShutdownHooks();
  configureApp(app);

  if (isLocal) {
    registerLocalTestConsole(app, config.get('PSP_BASE_URL', { infer: true }));
  }

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hamta Pay T-103 Wallet & Ledger API')
      .setDescription(
        'Crypto Exchange Wallet, Double-Entry Ledger, Deposits, Withdrawals, Transfers, and Reconciliation API',
      )
      .setVersion('1.0.0')
      .build();
    const documentFactory = () =>
      SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, documentFactory);
  }

  const port = config.get('PORT', { infer: true });

  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await app.listen(port, '0.0.0.0');
}

await bootstrap();
