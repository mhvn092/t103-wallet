import { describe, expect, it, vi } from 'vitest';
import { TransferController } from './transfer.controller.js';

describe('TransferController', () => {
  it('delegates request data and returns the service response body', async () => {
    const createTransfer = vi
      .fn()
      .mockResolvedValue({ body: { transferId: 't1' }, replayed: true });
    const controller = new TransferController({ createTransfer } as never);
    const dto = { toUserId: 'u2' } as never;
    await expect(controller.create('key', 'hash', dto)).resolves.toEqual({
      transferId: 't1',
    });
    expect(createTransfer).toHaveBeenCalledWith({
      idempotencyKey: 'key',
      requestHash: 'hash',
      dto,
    });
  });
});
