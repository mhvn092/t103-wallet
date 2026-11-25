import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from './canonical-json.util.js';

describe('sha256CanonicalJson', () => {
  it('sorts nested object keys, omits undefined properties, and preserves arrays', () => {
    const one = { z: 1, nested: { y: 2, x: undefined }, list: [2, 1] };
    const two = { list: [2, 1], nested: { y: 2 }, z: 1 };
    expect(sha256CanonicalJson(one)).toBe(sha256CanonicalJson(two));
    expect(sha256CanonicalJson({ list: [1, 2] })).not.toBe(
      sha256CanonicalJson({ list: [2, 1] }),
    );
    expect(sha256CanonicalJson(undefined)).toBe(
      createHash('sha256').update('null').digest('hex'),
    );
  });
});
