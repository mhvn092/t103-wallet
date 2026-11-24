import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { TransferController } from './transfer.controller.js';
import { TransferService } from './transfer.service.js';

@Module({
  imports: [IdempotencyModule, WalletModule, LedgerModule],
  controllers: [TransferController],
  providers: [TransferService],
})
export class TransferModule {}
