import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AdjustmentModule } from './modules/adjustment/adjustment.module.js';
import { DepositModule } from './modules/deposit/deposit.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { ProvidersModule } from './modules/providers/providers.module.js';
import { TransferModule } from './modules/transfer/transfer.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { WithdrawalModule } from './modules/withdrawal/withdrawal.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    HealthModule,
    WalletModule,
    LedgerModule,
    IdempotencyModule,
    AdjustmentModule,
    ProvidersModule,
    DepositModule,
    WithdrawalModule,
    TransferModule,
    OutboxModule,
  ],
})
export class AppModule {}
