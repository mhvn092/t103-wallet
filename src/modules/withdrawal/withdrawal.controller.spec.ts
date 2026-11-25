import { describe, expect, it, vi } from 'vitest';
import { WithdrawalController } from './withdrawal.controller.js';

describe('WithdrawalController', () => {
  it('delegates create and returns the response body', async () => {
    const result = { withdrawalId: 'w1' };
    const createWithdrawal = vi.fn().mockResolvedValue({ body: result });
    const controller = new WithdrawalController({ createWithdrawal } as never);
    const dto = { amount: '10' } as never;
    await expect(controller.create('key', 'hash', dto)).resolves.toBe(result);
    expect(createWithdrawal).toHaveBeenCalledWith({
      idempotencyKey: 'key',
      requestHash: 'hash',
      dto,
    });
  });

  it('delegates lookup and cancellation', async () => {
    const service = {
      getWithdrawal: vi.fn().mockResolvedValue({ withdrawalId: 'w2' }),
      cancelWithdrawal: vi
        .fn()
        .mockResolvedValue({ body: { withdrawalId: 'w2', status: 'FAILED' } }),
    };
    const controller = new WithdrawalController(service as never);
    await expect(controller.getWithdrawal('w2', 'u1')).resolves.toEqual({
      withdrawalId: 'w2',
    });
    await expect(
      controller.cancelWithdrawal(
        'w2',
        { userId: 'u1' } as never,
        'key',
        'hash',
      ),
    ).resolves.toEqual({ withdrawalId: 'w2', status: 'FAILED' });
    expect(service.getWithdrawal).toHaveBeenCalledWith('w2', 'u1');
    expect(service.cancelWithdrawal).toHaveBeenCalledWith({
      withdrawalId: 'w2',
      userId: 'u1',
      idempotencyKey: 'key',
      requestHash: 'hash',
    });
  });
});
