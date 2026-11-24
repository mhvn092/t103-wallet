import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyPreCheckGuard } from './idempotency.guard.js';
import { IdempotencyService } from './idempotency.service.js';
import { RetentionWorker } from './retention.worker.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdempotencyService, IdempotencyPreCheckGuard, RetentionWorker],
  exports: [IdempotencyService, IdempotencyPreCheckGuard, RetentionWorker],
})
export class IdempotencyModule {}
