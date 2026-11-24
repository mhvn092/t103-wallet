import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { DriftAuditWorker } from './drift-audit.worker.js';
import type { InternalOpsService } from './internal-ops.service.js';

class TestableDriftAuditWorker extends DriftAuditWorker {
  async tickForTest(): Promise<void> {
    await this.runTick();
  }
}

describe('DriftAuditWorker circuit-breaker', () => {
  it('does not pause withdrawals when driftCount is 0', async () => {
    const config = {
      get: () => 0,
    } as unknown as ConfigService<EnvConfig, true>;
    const refreshBalanceDriftGauge = vi.fn().mockResolvedValue(0);
    const setPausedWithdrawals = vi.fn();
    const worker = new TestableDriftAuditWorker(config, {
      refreshBalanceDriftGauge,
      setPausedWithdrawals,
    } as unknown as InternalOpsService);

    await worker.tickForTest();
    expect(refreshBalanceDriftGauge).toHaveBeenCalledTimes(1);
    expect(setPausedWithdrawals).not.toHaveBeenCalled();
  });

  it('automatically pauses IRT and USDT withdrawals when driftCount > 0', async () => {
    const config = {
      get: () => 0,
    } as unknown as ConfigService<EnvConfig, true>;
    const refreshBalanceDriftGauge = vi.fn().mockResolvedValue(2);
    const setPausedWithdrawals = vi.fn().mockResolvedValue({
      currencies: ['IRT', 'USDT'],
      updatedAt: new Date().toISOString(),
    });
    const worker = new TestableDriftAuditWorker(config, {
      refreshBalanceDriftGauge,
      setPausedWithdrawals,
    } as unknown as InternalOpsService);

    await worker.tickForTest();
    expect(setPausedWithdrawals).toHaveBeenCalledWith({
      currencies: ['IRT', 'USDT'],
      reason:
        'AUTO_CIRCUIT_BREAKER: balance drift detected on 2 USER account(s)',
    });
  });
});
