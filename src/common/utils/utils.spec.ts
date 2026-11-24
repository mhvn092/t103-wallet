import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from './canonical-json.js';
import { getTehranDateString } from './tehran-date.js';
import { generateUuidV7 } from './uuidv7.js';

describe('core utilities (uuidv7, canonical-json, tehran-date)', () => {
  it('generates monotonic RFC-9562 UUIDv7 strings', () => {
    const ids = Array.from({ length: 100 }, () => generateUuidV7());
    for (let i = 0; i < ids.length; i += 1) {
      expect(ids[i]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      if (i > 0) {
        expect(ids[i]! > ids[i - 1]!).toBe(true);
      }
    }
  });

  it('produces identical SHA-256 hashes regardless of object key order', () => {
    const a = { userId: 'u1', meta: { b: 2, a: 1 }, amount: '100000' };
    const b = { amount: '100000', meta: { a: 1, b: 2 }, userId: 'u1' };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(sha256CanonicalJson(a)).toBe(sha256CanonicalJson(b));
    expect(sha256CanonicalJson({ ...a, amount: '200000' })).not.toBe(
      sha256CanonicalJson(a),
    );
  });

  it('computes calendar date strictly in Asia/Tehran (+03:30)', () => {
    // 2026-11-23T20:29:59Z => 2026-11-23T23:59:59+03:30
    expect(getTehranDateString(new Date('2026-11-23T20:29:59Z'))).toBe(
      '2026-11-23',
    );
    // 2026-11-23T20:30:00Z => 2026-11-24T00:00:00+03:30
    expect(getTehranDateString(new Date('2026-11-23T20:30:00Z'))).toBe(
      '2026-11-24',
    );
  });
});
