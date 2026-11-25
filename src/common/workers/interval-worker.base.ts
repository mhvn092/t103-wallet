import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { EnvConfig } from '../../config/env.validation.js';

export abstract class IntervalWorkerBase
  implements OnModuleInit, OnModuleDestroy
{
  protected abstract readonly workerName: string;

  @Inject(SchedulerRegistry)
  private readonly _schedulerRegistry!: SchedulerRegistry;

  constructor(
    private readonly _workerConfigService: ConfigService<EnvConfig, true>,
  ) {}

  onModuleInit(): void {
    if (!this._workerConfigService.get('WORKERS_ENABLED', { infer: true })) {
      return;
    }
    this._stopped = false;
    this._scheduleNextTick();
  }

  private _scheduleNextTick(): void {
    const intervalMs = this._workerConfigService.get(
      'WORKER_POLL_INTERVAL_MS',
      { infer: true },
    );
    const job = new CronJob(new Date(Date.now() + intervalMs), () => {
      if (this._stopped) {
        return;
      }
      this._schedulerRegistry.deleteCronJob(this.workerName);
      this._scheduleNextTick();
      this._triggerTick();
    });
    this._schedulerRegistry.addCronJob(this.workerName, job);
    job.start();
  }

  async onModuleDestroy(): Promise<void> {
    this._stopped = true;
    if (this._schedulerRegistry.doesExist('cron', this.workerName)) {
      this._schedulerRegistry.deleteCronJob(this.workerName);
    }
    if (this._inFlight) {
      await this._inFlight;
    }
  }

  protected abstract runTick(): Promise<void>;

  private _triggerTick(): void {
    if (this._stopped || this._inFlight) {
      return;
    }
    this._inFlight = this._executeTick().finally(() => {
      this._inFlight = undefined;
    });
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

  private _inFlight: Promise<void> | undefined;
  private _stopped = true;
  private _logger: Logger | undefined;
}
