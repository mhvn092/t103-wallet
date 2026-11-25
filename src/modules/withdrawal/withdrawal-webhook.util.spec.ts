import { describe, expect, it } from 'vitest';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import { PayoutCurrencyEnum } from '../../common/enums/provider.enums.js';
import { detectProviderPayloadMismatch } from './withdrawal-webhook.util.js';

describe('withdrawal-webhook.util', () => {
  it('accepts matching IRT/IRR and USDT payloads and omits optional fields', () => {
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: undefined, currency: undefined },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: 1_500_000, currency: PayoutCurrencyEnum.IRR },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: '150000', currency: CurrencyEnum.IRT },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.USDT, amount: '10500000' },
        { amount: '10.5', currency: PayoutCurrencyEnum.USDT },
      ),
    ).toBe(false);
  });

  it('detects amount, currency, sub-Toman IRR remainder, and malformed mismatches', () => {
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: 9_990_000, currency: PayoutCurrencyEnum.IRR },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: 1_500_005, currency: PayoutCurrencyEnum.IRR },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.USDT, amount: '10500000' },
        { amount: '10.5', currency: PayoutCurrencyEnum.IRR },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: CurrencyEnum.IRT, amount: '150000' },
        { amount: 'not-a-number', currency: PayoutCurrencyEnum.IRR },
      ),
    ).toBe(true);
  });
});
