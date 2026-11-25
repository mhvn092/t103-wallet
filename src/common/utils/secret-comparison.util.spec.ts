import { describe, expect, it } from 'vitest';
import { matchesSecret } from './secret-comparison.util.js';

describe('matchesSecret', () => {
  it('compares configured and supplied secrets and rejects missing values', () => {
    expect(matchesSecret('secret', 'secret')).toBe(true);
    expect(matchesSecret('secret', 'other')).toBe(false);
    expect(matchesSecret('secret', undefined)).toBe(false);
  });
});
