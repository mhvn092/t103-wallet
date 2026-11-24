import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../../config/env.validation.js';

export abstract class IntervalWorkerBase
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly _workerConfig: ConfigService<EnvConfig, true>) {}

  onModuleInit(): void {
    if (!this._workerConfig.get('WORKERS_ENABLED', { infer: true })) {
      return;
    }
    this._stopped = false;
    this._scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this._stopped = true;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    if (this._inFlight) {
      await this._inFlight;
    }
  }

  protected abstract readonly workerName: string;
  protected abstract runTick(): Promise<void>;

  private _scheduleNext(): void {
    if (this._stopped) {
      return;
    }
    const intervalMs = this._workerConfig.get('WORKER_POLL_INTERVAL_MS', {
      infer: true,
    });
    this._timer = setTimeout(() => {
      this._inFlight = this._executeTick().finally(() => {
        this._inFlight = undefined;
        this._scheduleNext();
      });
    }, intervalMs);
  }

  private async _executeTick(): Promise<void> {
    try {
      await this.runTick();
    } catch (err) {
      this._logger ??= new Logger(this.workerName);
      this._logger.error(
        'Worker tick failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _inFlight: Promise<void> | undefined;
  private _stopped = true;
  private _logger: Logger | undefined;
}
