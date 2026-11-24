import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from './canonical-json.js';
import { getTehranDateString } from './tehran-date.js';
import { generateUuidV7 } from './uuidv7.js';

describe('core utilities (uuidv7, canonical-json, tehran-date)', () => {
  it('generates monotonic RFC-9562 UUIDv7 strings', () => {
    const ids = Array.from({ length: 100 }, () => generateUuidV7());
    for (let i = 0; i < ids.length; i += 1) {
      expect(ids[i]).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
      );
      if (i > 0) {
        const current = ids[i];
        const prev = ids[i - 1];
        expect(
          current !== undefined && prev !== undefined && current > prev,
        ).toBe(true);
      }
    }
  });

  it('produces identical SHA-256 hashes regardless of object key order', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (userId, amount, nestedVal) => {
          const a = { userId, meta: { b: nestedVal, a: 1 }, amount };
          const b = { amount, meta: { a: 1, b: nestedVal }, userId };
          expect(sha256CanonicalJson(a)).toBe(sha256CanonicalJson(b));
          expect(sha256CanonicalJson({ ...a, amount: `${amount}0` })).not.toBe(
            sha256CanonicalJson(a),
          );
        },
      ),
    );
  });

  it('computes calendar date strictly in Asia/Tehran (+03:30)', () => {
    expect(getTehranDateString(new Date('2026-11-23T20:29:59Z'))).toBe(
      '2026-11-23',
    );
    expect(getTehranDateString(new Date('2026-11-23T20:30:00Z'))).toBe(
      '2026-11-24',
    );
  });
});
