import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { WithdrawalService } from './withdrawal.service.js';

@Injectable()
export class WithdrawalWorker extends IntervalWorkerBase {
  protected readonly workerName = WithdrawalWorker.name;

  constructor(
    config: ConfigService<EnvConfig, true>,
    private readonly _withdrawalService: WithdrawalService,
  ) {
    super(config);
  }

  protected async runTick(): Promise<void> {
    await this._withdrawalService.dispatchPendingBatch();
    await this._withdrawalService.pollProcessingBatch();
  }
}
