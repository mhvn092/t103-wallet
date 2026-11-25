import { describe, expect, it } from 'vitest';
import {
  assertValidCalendarDate,
  formatSignedIrtMinor,
} from './reconciliation-date.util.js';

describe('reconciliation date utilities', () => {
  it('validates real calendar dates and preserves the input format', () => {
    expect(assertValidCalendarDate('2024-02-29')).toBe('2024-02-29');
    for (const invalid of ['2023-02-29', '2024-13-01', '2024-04-31', 'x-y-z']) {
      expect(() => assertValidCalendarDate(invalid)).toThrow(
        /Invalid calendar date/,
      );
    }
  });

  it('formats signed IRT minor units without floating point', () => {
    expect(formatSignedIrtMinor(123n)).toBe('123');
    expect(formatSignedIrtMinor(-123n)).toBe('-123');
    expect(formatSignedIrtMinor(0n)).toBe('0');
  });
});
