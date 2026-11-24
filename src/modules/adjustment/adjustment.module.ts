import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdjustmentController } from './adjustment.controller.js';
import { AdjustmentService } from './adjustment.service.js';
import { DriftAuditWorker } from './drift-audit.worker.js';
import { InternalOpsController } from './internal-ops.controller.js';
import { InternalOpsGuard } from './internal-ops.guard.js';
import { InternalOpsService } from './internal-ops.service.js';

@Module({
  imports: [DatabaseModule, IdempotencyModule, WalletModule, LedgerModule],
  controllers: [AdjustmentController, InternalOpsController],
  providers: [
    AdjustmentService,
    InternalOpsService,
    InternalOpsGuard,
    DriftAuditWorker,
  ],
  exports: [InternalOpsGuard],
})
export class AdjustmentModule {}
