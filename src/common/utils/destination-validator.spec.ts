import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertValidDestination,
  isValidIranianIban,
  isValidTrc20Address,
} from './destination-validator.js';

function buildValidIranianIban(bban22: string): string {
  // 'IR00' moved to end => '182700' where I=18, R=27
  const numericBody = `${bban22}182700`;
  let remainder = 0;
  for (const ch of numericBody) {
    remainder = (remainder * 10 + (ch.charCodeAt(0) - 48)) % 97;
  }
  const checkDigits = String(98 - remainder).padStart(2, '0');
  return `IR${checkDigits}${bban22}`;
}

describe('destination-validator', () => {
  it('validates real ISO-13616 Mod-97 Iranian IBANs and rejects bad checksums', () => {
    expect(isValidIranianIban('IR062960000000100324200001')).toBe(true);
    expect(isValidIranianIban('ir062960000000100324200001')).toBe(true);
    expect(isValidIranianIban('IR072960000000100324200001')).toBe(false);
    expect(isValidIranianIban('DE89370400440532013000')).toBe(false);
    expect(isValidIranianIban('IR06296000000010032420000')).toBe(false);
  });

  it('accepts generated valid Iranian IBANs and rejects any single-digit mutation', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{22}$/),
        fc.integer({ min: 2, max: 25 }),
        (bban, mutateIndex) => {
          const valid = buildValidIranianIban(bban);
          expect(isValidIranianIban(valid)).toBe(true);

          const originalDigit = Number(valid[mutateIndex]);
          const mutatedDigit = String((originalDigit + 1) % 10);
          const corrupted = `${valid.slice(0, mutateIndex)}${mutatedDigit}${valid.slice(mutateIndex + 1)}`;
          expect(isValidIranianIban(corrupted)).toBe(false);
        },
      ),
    );
  });

  it('validates Base58Check TRC20 addresses and rejects forged checksums', () => {
    expect(isValidTrc20Address('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(
      true,
    );
    expect(isValidTrc20Address('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6s')).toBe(
      false,
    );
    expect(isValidTrc20Address('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(
      false,
    );
    expect(isValidTrc20Address('T123')).toBe(false);
  });

  it('throws DomainException INVALID_DESTINATION on invalid destinations', () => {
    expect(assertValidDestination('ir062960000000100324200001', 'IRT')).toBe(
      'IR062960000000100324200001',
    );
    expect(() => assertValidDestination('IR00000', 'IRT')).toThrow(
      /Iranian IBAN/,
    );
    expect(() => assertValidDestination('TBadAddress', 'USDT')).toThrow(
      /TRC20/,
    );
  });
});
