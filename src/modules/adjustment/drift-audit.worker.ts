import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Currency } from '../../common/enums/domain.enums.js';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { InternalOpsService } from './internal-ops.service.js';

@Injectable()
export class DriftAuditWorker extends IntervalWorkerBase {
  protected readonly workerName = DriftAuditWorker.name;

  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _internalOpsService: InternalOpsService,
  ) {
    super(_configService);
  }

  protected async runTick(): Promise<void> {
    const intervalMs = this._configService.get('DRIFT_AUDIT_INTERVAL_MS', {
      infer: true,
    });
    const nowMs = Date.now();
    if (nowMs - this._lastRunAtMs < intervalMs) {
      return;
    }
    this._lastRunAtMs = nowMs;

    const driftCount =
      await this._internalOpsService.refreshBalanceDriftGauge();
    if (driftCount > 0) {
      this._auditLogger.error(
        `CRITICAL: Balance drift detected on ${driftCount} USER account(s); tripping automatic withdrawal pause circuit breaker`,
      );
      await this._internalOpsService.setPausedWithdrawals({
        currencies: [Currency.IRT, Currency.USDT],
        reason: `AUTO_CIRCUIT_BREAKER: balance drift detected on ${driftCount} USER account(s)`,
      });
    }
  }

  private _lastRunAtMs = 0;
  private readonly _auditLogger = new Logger(DriftAuditWorker.name);
}
