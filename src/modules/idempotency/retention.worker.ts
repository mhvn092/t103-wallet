import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidV7LowerBoundForMs } from '../../common/utils/uuidv7.util.js';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';

const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
    const nowMs = Date.now();
    const outboxCutoffId = uuidV7LowerBoundForMs(nowMs - OUTBOX_RETENTION_MS);
    const processedCutoffId = uuidV7LowerBoundForMs(
      nowMs - PROCESSED_EVENTS_RETENTION_MS,
    );
    const [idempotencyDeleted, outboxDeleted, processedDeleted] =
      await Promise.all([
        this._deleteBatch(
          `DELETE FROM idempotency_keys
           WHERE (scope, key) IN (
             SELECT scope, key FROM idempotency_keys
             WHERE expires_at < NOW()
             ORDER BY expires_at, scope, key
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )`,
          [safeLimit],
        ),
        this._deleteBatch(
          `DELETE FROM outbox_events
           WHERE id IN (
             SELECT id FROM outbox_events
             WHERE id < $2::uuid
               AND status = 'PUBLISHED'
               AND published_at < NOW() - INTERVAL '7 days'
             ORDER BY id
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )`,
          [safeLimit, outboxCutoffId],
        ),
        this._deleteBatch(
          `DELETE FROM processed_events
           WHERE (event_id, consumer_name) IN (
             SELECT event_id, consumer_name FROM processed_events
             WHERE event_id < $2::uuid
               AND processed_at < NOW() - INTERVAL '30 days'
             ORDER BY event_id, consumer_name
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )`,
          [safeLimit, processedCutoffId],
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

  private async _deleteBatch(
    sqlText: string,
    params: unknown[],
  ): Promise<number> {
    const result = await this._databaseService.pool.query(sqlText, params);
    return result.rowCount ?? 0;
  }

  private _lastRunAtMs = 0;
  private readonly _retentionLogger = new Logger(RetentionWorker.name);
}
