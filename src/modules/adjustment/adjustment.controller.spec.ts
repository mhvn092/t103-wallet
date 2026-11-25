import { describe, expect, it, vi } from 'vitest';
import { AdjustmentController } from './adjustment.controller.js';

describe('AdjustmentController', () => {
  it('returns the service body and defaults a blank operator id', async () => {
    const createAdjustment = vi
      .fn()
      .mockResolvedValue({ body: { id: 'a1' }, replayed: false });
    const controller = new AdjustmentController({ createAdjustment } as never);
    const body = { userId: 'u1' } as never;
    await expect(controller.create('key', 'hash', body, '  ')).resolves.toEqual(
      { id: 'a1' },
    );
    expect(createAdjustment).toHaveBeenCalledWith(
      'key',
      body,
      'system-ops',
      'hash',
    );
  });

  it('trims a supplied operator id', async () => {
    const createAdjustment = vi.fn().mockResolvedValue({ body: { id: 'a2' } });
    const controller = new AdjustmentController({ createAdjustment } as never);
    await controller.create('key', undefined, {} as never, ' operator-7 ');
    expect(createAdjustment).toHaveBeenCalledWith(
      'key',
      {},
      'operator-7',
      undefined,
    );
  });
});
