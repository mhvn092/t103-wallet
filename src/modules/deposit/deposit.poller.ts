import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DepositService } from './deposit.service.js';

@Injectable()
export class DepositPoller extends IntervalWorkerBase {
  protected readonly workerName = DepositPoller.name;

  constructor(
    config: ConfigService<EnvConfig, true>,
    private readonly _depositService: DepositService,
  ) {
    super(config);
  }

  protected async runTick(): Promise<void> {
    await this._depositService.pollPendingDeposits();
  }
}
