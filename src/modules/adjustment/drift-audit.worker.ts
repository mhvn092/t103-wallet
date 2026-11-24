import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { InternalOpsService } from './internal-ops.service.js';

@Injectable()
export class DriftAuditWorker extends IntervalWorkerBase {
  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _internalOpsService: InternalOpsService,
  ) {
    super(_config);
  }

  protected readonly workerName = DriftAuditWorker.name;

  protected async runTick(): Promise<void> {
    const intervalMs = this._config.get('DRIFT_AUDIT_INTERVAL_MS', {
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
      this._auditLogger.warn(
        `Balance drift detected on ${driftCount} USER account(s)`,
      );
    }
  }

  private _lastRunAtMs = 0;
  private readonly _auditLogger = new Logger(DriftAuditWorker.name);
}
