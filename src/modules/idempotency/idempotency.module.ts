import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyService } from './idempotency.service.js';
import { RetentionWorker } from './retention.worker.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdempotencyService, RetentionWorker],
  exports: [IdempotencyService, RetentionWorker],
})
export class IdempotencyModule {}
