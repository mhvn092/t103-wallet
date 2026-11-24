import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addPositiveJitterMs, computeSafeLeaseMs } from './backoff.js';
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

  it('scales worker leases strictly above PROVIDER_HTTP_TIMEOUT_MS and applies non-shrinking jitter', () => {
    expect(computeSafeLeaseMs(45_000, 10_000, 2, 15_000)).toBe(45_000);
    expect(computeSafeLeaseMs(45_000, 60_000, 2, 15_000)).toBe(135_000);
    expect(computeSafeLeaseMs(15_000, 60_000, 1, 10_000)).toBe(70_000);

    for (let i = 0; i < 20; i += 1) {
      const jittered = addPositiveJitterMs(70_000, 0.2);
      expect(jittered).toBeGreaterThanOrEqual(70_000);
      expect(jittered).toBeLessThanOrEqual(84_000);
    }
    expect(addPositiveJitterMs(0)).toBe(0);
  });
});
