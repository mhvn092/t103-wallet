import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { EnvConfig } from './config/env.validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  const config = app.get(ConfigService<EnvConfig, true>);
  const isProd = config.get('APP_ENV', { infer: true }) === 'production';

  app.useLogger(
    new ConsoleLogger({
      json: isProd,
      logLevels: isProd
        ? ['log', 'warn', 'error', 'fatal']
        : ['log', 'warn', 'error', 'fatal', 'debug'],
    }),
  );
  app.enableShutdownHooks();
  configureApp(app);

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
