import type { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { IntervalWorkerBase } from './interval-worker.base.js';

class TestWorker extends IntervalWorkerBase {
  protected readonly workerName = 'TestWorker';

  constructor(
    config: ConfigService<EnvConfig, true>,
    private readonly _tick: () => Promise<void>,
  ) {
    super(config);
  }

  protected async runTick(): Promise<void> {
    await this._tick();
  }
}

function createWorker(enabled: boolean, tick: () => Promise<void>) {
  const config = {
    get: (key: string) => (key === 'WORKERS_ENABLED' ? enabled : 400),
  } as unknown as ConfigService<EnvConfig, true>;
  const registry = new SchedulerRegistry();
  const worker = new TestWorker(config, tick);
  Reflect.set(worker, '_schedulerRegistry', registry);
  return { worker, registry };
}

describe('worker scheduling', () => {
  afterEach(() => vi.useRealTimers());

  it('runs on the configured millisecond interval without overlapping and drains on shutdown', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const tick = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { worker, registry } = createWorker(true, tick);
    worker.onModuleInit();
    expect(registry.doesExist('cron', 'TestWorker')).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(tick).toHaveBeenCalledTimes(1);

    let stopped = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.();
    await shutdown;
    expect(stopped).toBe(true);
    expect(registry.doesExist('cron', 'TestWorker')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not schedule jobs when workers are disabled', async () => {
    const tick = vi.fn();
    const { worker, registry } = createWorker(false, tick);
    worker.onModuleInit();
    expect(registry.doesExist('cron', 'TestWorker')).toBe(false);
    await worker.onModuleDestroy();
    expect(tick).not.toHaveBeenCalled();
  });
});
