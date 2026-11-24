import { describe, expect, it } from 'vitest';
import {
  assertValidDestination,
  isValidIranianIban,
  isValidTrc20Address,
} from './destination-validator.js';

describe('destination-validator', () => {
  it('validates real ISO-13616 Mod-97 Iranian IBANs and rejects bad checksums', () => {
    // Check digit verification: IR06 + 22 digits => Mod97 == 1
    expect(isValidIranianIban('IR062960000000100324200001')).toBe(true);
    expect(isValidIranianIban('ir062960000000100324200001')).toBe(true);
    expect(isValidIranianIban('IR072960000000100324200001')).toBe(false);
    expect(isValidIranianIban('DE89370400440532013000')).toBe(false);
    expect(isValidIranianIban('IR06296000000010032420000')).toBe(false);
  });

  it('validates Base58Check TRC20 addresses and rejects forged checksums', () => {
    // Well-known TRON USDT contract address (valid Base58Check starting with 0x41 -> 'T')
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
    expect(
      assertValidDestination('ir062960000000100324200001', 'IRT'),
    ).toBe('IR062960000000100324200001');
    expect(() => assertValidDestination('IR00000', 'IRT')).toThrow(
      /Iranian IBAN/,
    );
    expect(() => assertValidDestination('TBadAddress', 'USDT')).toThrow(
      /TRC20/,
    );
  });
});
