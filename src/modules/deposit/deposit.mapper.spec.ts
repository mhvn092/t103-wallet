import { describe, expect, it, vi } from 'vitest';
import { DepositStatusEnum } from '../../common/enums/deposit.enums.js';
import {
  computePostExpiryGracePollAt,
  toDepositDetailResponseDto,
} from './deposit.mapper.js';

describe('deposit mapper', () => {
  it('maps nullable and present dates to the API representation', () => {
    const createdAt = new Date('2025-01-01T00:00:00.000Z');
    expect(
      toDepositDetailResponseDto({
        id: 'd1',
        userId: 'u1',
        requestedAmount: '10',
        verifiedAmount: null,
        amountMismatch: false,
        pspToken: null,
        pspRefId: null,
        paymentUrl: null,
        status: DepositStatusEnum.INITIATED,
        expiresAt: null,
        verifiedAt: null,
        createdAt,
        updatedAt: createdAt,
      } as never),
    ).toMatchObject({
      depositId: 'd1',
      requestedAmount: '10',
      expiresAt: null,
      verifiedAt: null,
      createdAt: createdAt.toISOString(),
    });
  });

  it('uses grace polling steps and stops after the grace deadline', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const expiry = new Date(0);
    expect(computePostExpiryGracePollAt(expiry, 0, 100_000)?.getTime()).toBe(
      30_000,
    );
    expect(
      computePostExpiryGracePollAt(expiry, 120_000, 400_000)?.getTime(),
    ).toBe(240_000);
    expect(
      computePostExpiryGracePollAt(expiry, 300_000, 500_000)?.getTime(),
    ).toBe(500_000);
    expect(computePostExpiryGracePollAt(expiry, 100_000, 0)).toBeNull();
    expect(computePostExpiryGracePollAt(expiry, 10_000, 10_000)).toBeNull();
    vi.restoreAllMocks();
  });
});
