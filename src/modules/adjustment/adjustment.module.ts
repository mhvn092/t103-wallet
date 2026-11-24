import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdjustmentController } from './adjustment.controller.js';
import { AdjustmentService } from './adjustment.service.js';
import { InternalOpsGuard } from './internal-ops.guard.js';

@Module({
  imports: [IdempotencyModule, WalletModule, LedgerModule],
  controllers: [AdjustmentController],
  providers: [AdjustmentService, InternalOpsGuard],
})
export class AdjustmentModule {}
