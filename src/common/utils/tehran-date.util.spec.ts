import { describe, expect, it } from 'vitest';
import { getTehranDateString } from './tehran-date.util.js';

describe('getTehranDateString', () => {
  it('uses the Tehran calendar date including its UTC+03:30 boundary', () => {
    expect(getTehranDateString(new Date('2025-01-01T20:45:00.000Z'))).toBe(
      '2025-01-02',
    );
    expect(getTehranDateString(new Date('2025-01-01T20:29:59.000Z'))).toBe(
      '2025-01-01',
    );
  });
});
