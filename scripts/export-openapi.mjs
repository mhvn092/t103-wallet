import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

process.env.DATABASE_URI ??= 'postgresql://127.0.0.1:5432/t103_openapi';
process.env.RABBITMQ_URI ??= 'amqp://127.0.0.1:5672';
process.env.WEBHOOK_SECRET ??= randomBytes(24).toString('hex');
process.env.WORKERS_ENABLED ??= 'false';
process.env.APP_ENV ??= 'local';

const { AppModule } = await import('../dist/app.module.js');
const { configureApp } = await import('../dist/app.setup.js');

const app = await NestFactory.create(AppModule, { logger: false });
configureApp(app);

const swaggerConfig = new DocumentBuilder()
  .setTitle('Hamta Pay T-103 Wallet & Ledger API')
  .setDescription(
    'Crypto Exchange Wallet, Double-Entry Ledger, Deposits, Withdrawals, Transfers, and Reconciliation API',
  )
  .setVersion('1.0.0')
  .build();

const document = SwaggerModule.createDocument(app, swaggerConfig);
const outPath = resolve(import.meta.dirname, '../docs/openapi.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

await app.close();
console.log(`Exported OpenAPI spec to ${outPath}`);
