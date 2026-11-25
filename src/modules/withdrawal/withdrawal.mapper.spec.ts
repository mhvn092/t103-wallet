import { describe, expect, it } from 'vitest';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  computeWithdrawalPolicyAmounts,
  isWebhookAmountValid,
  toWithdrawalResponseDto,
} from './withdrawal.mapper.js';

describe('withdrawal mapper', () => {
  it('applies IRT and USDT fee and conversion policies', () => {
    const values = {
      DAILY_LIMIT_IRT: '1000',
      USDT_WITHDRAWAL_FEE: '0.5',
      USDT_IRT_RATE: '600000',
    };
    const config = { get: (key: keyof typeof values) => values[key] } as never;
    expect(
      computeWithdrawalPolicyAmounts(config, 100n, CurrencyEnum.IRT),
    ).toEqual({
      feeMinor: 0n,
      fxRateIrt: 1n,
      irtEquivalent: 100n,
      dailyLimitIrt: 1000n,
    });
    expect(
      computeWithdrawalPolicyAmounts(config, 1_000_001n, CurrencyEnum.USDT),
    ).toEqual({
      feeMinor: 500_000n,
      fxRateIrt: 600_000n,
      irtEquivalent: 600_001n,
      dailyLimitIrt: 1000n,
    });
  });

  it('accepts exact IRT/IRR/USDT callback amounts and rejects malformed or fractional IRR', () => {
    expect(isWebhookAmountValid(CurrencyEnum.IRT, 100n, '100', 'IRT')).toBe(
      true,
    );
    expect(isWebhookAmountValid(CurrencyEnum.IRT, 100n, 1000, 'IRR')).toBe(
      true,
    );
    expect(isWebhookAmountValid(CurrencyEnum.IRT, 100n, 1001, 'IRR')).toBe(
      false,
    );
    expect(isWebhookAmountValid(CurrencyEnum.USDT, 1_500_000n, '1.5')).toBe(
      true,
    );
    expect(isWebhookAmountValid(CurrencyEnum.USDT, 1n, 'not-money')).toBe(
      false,
    );
  });

  it('formats response amounts in currency units', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(
      toWithdrawalResponseDto({
        id: 'w1',
        userId: 'u1',
        currency: CurrencyEnum.USDT,
        amount: '1500000',
        fee: '500000',
        status: 'PENDING',
        destination: 'T1',
        providerRequestId: null,
        providerRefId: null,
        failureReason: null,
        lateSuccessConflict: false,
        createdAt: now,
        updatedAt: now,
      } as never),
    ).toMatchObject({ withdrawalId: 'w1', amount: '1.5', fee: '0.5' });
  });
});
