import { describe, expect, it } from 'vitest';
import { detectProviderPayloadMismatch } from './withdrawal-webhook.util.js';

describe('withdrawal-webhook.util', () => {
  it('accepts matching IRT/IRR and USDT payloads and omits optional fields', () => {
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: undefined, currency: undefined },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: 1_500_000, currency: 'IRR' },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: '150000', currency: 'IRT' },
      ),
    ).toBe(false);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'USDT', amount: '10500000' },
        { amount: '10.5', currency: 'USDT' },
      ),
    ).toBe(false);
  });

  it('detects amount, currency, sub-Toman IRR remainder, and malformed mismatches', () => {
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: 9_990_000, currency: 'IRR' },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: 1_500_005, currency: 'IRR' },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'USDT', amount: '10500000' },
        { amount: '10.5', currency: 'IRR' },
      ),
    ).toBe(true);
    expect(
      detectProviderPayloadMismatch(
        { currency: 'IRT', amount: '150000' },
        { amount: 'not-a-number', currency: 'IRR' },
      ),
    ).toBe(true);
  });
});
