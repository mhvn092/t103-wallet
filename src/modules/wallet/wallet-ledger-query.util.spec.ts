import { describe, expect, it } from 'vitest';
import {
  MAX_PG_BIGINT,
  isValidPositiveBigIntCursor,
} from './wallet-ledger-query.util.js';

describe('wallet-ledger-query.util (F-08)', () => {
  it('accepts valid positive 64-bit signed integer cursors up to MAX_PG_BIGINT', () => {
    expect(isValidPositiveBigIntCursor('1')).toBe(true);
    expect(isValidPositiveBigIntCursor('42')).toBe(true);
    expect(isValidPositiveBigIntCursor(MAX_PG_BIGINT.toString())).toBe(true);
  });

  it('rejects BIGINT overflows, zero, negative numbers, and non-digit strings', () => {
    expect(isValidPositiveBigIntCursor((MAX_PG_BIGINT + 1n).toString())).toBe(
      false,
    );
    expect(isValidPositiveBigIntCursor('99999999999999999999')).toBe(false);
    expect(isValidPositiveBigIntCursor('0')).toBe(false);
    expect(isValidPositiveBigIntCursor('-1')).toBe(false);
    expect(isValidPositiveBigIntCursor('01')).toBe(false);
    expect(isValidPositiveBigIntCursor('abc')).toBe(false);
    expect(isValidPositiveBigIntCursor(123)).toBe(false);
  });
});
