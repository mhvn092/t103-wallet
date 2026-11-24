import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { InternalOpsService } from './internal-ops.service.js';

function createService(opts: {
  workersEnabled: boolean;
  driftIntervalMs?: number;
  poolQueryImpl?: () => Promise<{ rows: Array<{ drift_count: number }> }>;
}) {
  const poolQuery = vi.fn(
    opts.poolQueryImpl ?? (async () => ({ rows: [{ drift_count: 0 }] })),
  );
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() =>
      Object.assign(Promise.resolve([{ count: 0 }]), {
        limit: vi.fn().mockResolvedValue([]),
      }),
    ),
  };
  const dbSelect = vi.fn(() => selectChain);

  const config = {
    get: (key: keyof EnvConfig) => {
      if (key === 'DRIFT_AUDIT_INTERVAL_MS') {
        return opts.driftIntervalMs ?? 60_000;
      }
      if (key === 'WORKERS_ENABLED') {
        return opts.workersEnabled;
      }
      return undefined;
    },
  } as unknown as ConfigService<EnvConfig, true>;

  const database = {
    db: { select: dbSelect },
    pool: { query: poolQuery },
  } as unknown as DatabaseService;

  const service = new InternalOpsService(
    config,
    database,
    {} as IdempotencyService,
    {} as WalletService,
    {} as LedgerService,
  );

  return { service, poolQuery };
}

describe('InternalOpsService balance drift cache (R-03)', () => {
  it('caches balanceDriftAccounts within DRIFT_AUDIT_INTERVAL_MS and coalesces concurrent cold-start scrapes', async () => {
    let releaseQuery!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });

    const { service, poolQuery } = createService({
      workersEnabled: true,
      driftIntervalMs: 60_000,
      poolQueryImpl: async () => {
        await gate;
        return { rows: [{ drift_count: 0 }] };
      },
    });

    const p1 = service.getMetrics();
    const p2 = service.getMetrics();
    releaseQuery();
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.balanceDriftAccounts).toBe(0);
    expect(m2.balanceDriftAccounts).toBe(0);
    expect(poolQuery).toHaveBeenCalledTimes(1);

    const m3 = await service.getMetrics();
    expect(m3.balanceDriftAccounts).toBe(0);
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('returns cached balanceDriftAccounts without blocking when WORKERS_ENABLED=true and cache is stale', async () => {
    let callCount = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const { service, poolQuery } = createService({
      workersEnabled: true,
      driftIntervalMs: 1_000,
      poolQueryImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { rows: [{ drift_count: 0 }] };
        }
        await secondGate;
        return { rows: [{ drift_count: 2 }] };
      },
    });

    const first = await service.getMetrics();
    expect(first.balanceDriftAccounts).toBe(0);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1_500);
      const staleRead = await service.getMetrics();
      expect(staleRead.balanceDriftAccounts).toBe(0);
      expect(poolQuery).toHaveBeenCalledTimes(2);

      releaseSecond();
      await vi.waitFor(async () => {
        const refreshed = await service.getMetrics();
        expect(refreshed.balanceDriftAccounts).toBe(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
