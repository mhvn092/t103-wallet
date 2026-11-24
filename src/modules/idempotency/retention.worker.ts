import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';

interface RetentionPurgeSummary {
  idempotencyDeleted: number;
  outboxDeleted: number;
  processedDeleted: number;
}

@Injectable()
export class RetentionWorker extends IntervalWorkerBase {
  protected readonly workerName = RetentionWorker.name;

  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
  ) {
    super(_configService);
  }

  async purgeExpiredOperationalRecords(
    batchSize = 1000,
  ): Promise<RetentionPurgeSummary> {
    const safeLimit = Math.max(1, Math.min(batchSize, 10_000));
    const [idempotencyDeleted, outboxDeleted, processedDeleted] =
      await Promise.all([
        this._deleteBatch(
          `DELETE FROM idempotency_keys
           WHERE ctid IN (
             SELECT ctid FROM idempotency_keys
             WHERE expires_at < NOW()
             LIMIT $1
           )`,
          safeLimit,
        ),
        this._deleteBatch(
          `DELETE FROM outbox_events
           WHERE ctid IN (
             SELECT ctid FROM outbox_events
             WHERE status = 'PUBLISHED' AND published_at < NOW() - INTERVAL '7 days'
             LIMIT $1
           )`,
          safeLimit,
        ),
        this._deleteBatch(
          `DELETE FROM processed_events
           WHERE ctid IN (
             SELECT ctid FROM processed_events
             WHERE processed_at < NOW() - INTERVAL '30 days'
             LIMIT $1
           )`,
          safeLimit,
        ),
      ]);

    return {
      idempotencyDeleted,
      outboxDeleted,
      processedDeleted,
    };
  }

  protected async runTick(): Promise<void> {
    const intervalMs = this._configService.get(
      'RETENTION_CLEANUP_INTERVAL_MS',
      {
        infer: true,
      },
    );
    const nowMs = Date.now();
    if (nowMs - this._lastRunAtMs < intervalMs) {
      return;
    }
    this._lastRunAtMs = nowMs;

    const summary = await this.purgeExpiredOperationalRecords();
    const total =
      summary.idempotencyDeleted +
      summary.outboxDeleted +
      summary.processedDeleted;
    if (total > 0) {
      this._retentionLogger.log(
        `Purged expired operational rows: idempotency=${summary.idempotencyDeleted} outbox=${summary.outboxDeleted} processed=${summary.processedDeleted}`,
      );
    }
  }

  private async _deleteBatch(sqlText: string, limit: number): Promise<number> {
    const result = await this._databaseService.pool.query(sqlText, [limit]);
    return result.rowCount ?? 0;
  }

  private _lastRunAtMs = 0;
  private readonly _retentionLogger = new Logger(RetentionWorker.name);
}
