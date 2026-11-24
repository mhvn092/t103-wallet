import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PayoutWebhookController } from './payout-webhook.controller.js';
import { WithdrawalController } from './withdrawal.controller.js';
import { WithdrawalService } from './withdrawal.service.js';
import { WithdrawalWorker } from './withdrawal.worker.js';

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    WalletModule,
    LedgerModule,
    ProvidersModule,
  ],
  controllers: [WithdrawalController, PayoutWebhookController],
  providers: [WithdrawalService, WithdrawalWorker],
})
export class WithdrawalModule {}
