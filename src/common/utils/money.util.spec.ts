import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Currency } from '../enums/domain.enums.js';
import {
  MAX_AMOUNT_MINOR,
  USDT_MINOR_PER_UNIT,
  convertUsdtToIrtCeiling,
  formatMinorToApi,
  parseAmountToMinor,
} from './money.util.js';

describe('money utilities', () => {
  it('parses IRT positive integer strings and rejects floats/zero/negatives/overflow', () => {
    expect(parseAmountToMinor('100000', Currency.IRT)).toBe(100_000n);
    expect(parseAmountToMinor(MAX_AMOUNT_MINOR.toString(), Currency.IRT)).toBe(
      MAX_AMOUNT_MINOR,
    );
    expect(parseAmountToMinor('0', Currency.IRT, { allowZero: true })).toBe(0n);
    expect(() => parseAmountToMinor('0', Currency.IRT)).toThrow();
    expect(() => parseAmountToMinor('100.5', Currency.IRT)).toThrow();
    expect(() => parseAmountToMinor('-500', Currency.IRT)).toThrow();
    expect(() => parseAmountToMinor('1e5', Currency.IRT)).toThrow();
    expect(() =>
      parseAmountToMinor((MAX_AMOUNT_MINOR + 1n).toString(), Currency.IRT),
    ).toThrow(/maximum allowed magnitude/);
    expect(() =>
      parseAmountToMinor('1000000000.000001', Currency.USDT),
    ).toThrow(/maximum allowed magnitude/);
  });

  it('parses USDT up to 6 decimals into micro-USDT bigint without float precision loss', () => {
    expect(parseAmountToMinor('10', Currency.USDT)).toBe(10_000_000n);
    expect(parseAmountToMinor('0.1', Currency.USDT)).toBe(100_000n);
    expect(parseAmountToMinor('0.000001', Currency.USDT)).toBe(1n);
    expect(parseAmountToMinor('123456.789012', Currency.USDT)).toBe(
      123_456_789_012n,
    );
    expect(() => parseAmountToMinor('1.1234567', Currency.USDT)).toThrow();
    expect(() => parseAmountToMinor('0.000000', Currency.USDT)).toThrow();
  });

  it('formats IRT and USDT minor units accurately', () => {
    expect(formatMinorToApi(250_000n, Currency.IRT)).toBe('250000');
    expect(formatMinorToApi(0n, Currency.USDT)).toBe('0');
    expect(formatMinorToApi(50_000_000n, Currency.USDT)).toBe('50');
    expect(formatMinorToApi(10_500_000n, Currency.USDT)).toBe('10.5');
    expect(formatMinorToApi(1n, Currency.USDT)).toBe('0.000001');
  });

  it('computes ceiling integer USDT->IRT conversion', () => {
    expect(convertUsdtToIrtCeiling(10_000_000n, 60_000n)).toBe(600_000n);
    expect(convertUsdtToIrtCeiling(1n, 60_000n)).toBe(1n);
    expect(convertUsdtToIrtCeiling(16n, 60_000n)).toBe(1n);
    expect(convertUsdtToIrtCeiling(17n, 60_000n)).toBe(2n);
  });

  it('round-trips arbitrary positive IRT and USDT minor units and preserves ceiling inequalities', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), (minor) => {
        expect(
          parseAmountToMinor(
            formatMinorToApi(minor, Currency.IRT),
            Currency.IRT,
          ),
        ).toBe(minor);
      }),
    );

    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), (minor) => {
        expect(
          parseAmountToMinor(
            formatMinorToApi(minor, Currency.USDT),
            Currency.USDT,
          ),
        ).toBe(minor);
      }),
    );

    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (usdtMinor, fxRate) => {
          const irt = convertUsdtToIrtCeiling(usdtMinor, fxRate);
          const numerator = usdtMinor * fxRate;
          expect(irt * USDT_MINOR_PER_UNIT >= numerator).toBe(true);
          expect((irt - 1n) * USDT_MINOR_PER_UNIT < numerator).toBe(true);
        },
      ),
    );
  });
});
