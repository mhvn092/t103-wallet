import { describe, expect, it } from 'vitest';
import { emptyToUndefined } from './string-normalizer.util.js';

describe('emptyToUndefined', () => {
  it('converts blank strings while preserving other values', () => {
    expect(emptyToUndefined('  ')).toBeUndefined();
    expect(emptyToUndefined(' value ')).toBe(' value ');
    expect(emptyToUndefined(null)).toBeNull();
    expect(emptyToUndefined(0)).toBe(0);
  });
});
