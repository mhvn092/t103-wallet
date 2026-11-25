import { describe, expect, it } from 'vitest';
import { assertValidUuid } from './uuid-validation.util.js';

describe('assertValidUuid', () => {
  it('trims valid UUIDs and reports the requested field for invalid values', () => {
    expect(assertValidUuid('  550e8400-e29b-41d4-a716-446655440000  ')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(() => assertValidUuid('nope', 'eventId')).toThrow(/eventId/);
  });
});
