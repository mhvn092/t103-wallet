import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { DepositController } from './deposit.controller.js';
import { DepositPoller } from './deposit.poller.js';
import { DepositService } from './deposit.service.js';

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    WalletModule,
    LedgerModule,
    ProvidersModule,
  ],
  controllers: [DepositController],
  providers: [DepositService, DepositPoller],
  exports: [DepositService],
})
export class DepositModule {}
