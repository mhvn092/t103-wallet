import { createHmac, randomBytes } from 'node:crypto';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { verifyHmacSha256Hex } from './hmac.util.js';

describe('verifyHmacSha256Hex', () => {
  it('accepts valid lowercase and uppercase signatures for any payload and secret', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        (payloadText) => {
          const secret = randomBytes(24).toString('hex');
          const rawBody = Buffer.from(payloadText, 'utf8');
          const sig = createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');

          expect(verifyHmacSha256Hex(rawBody, sig, secret)).toBe(true);
          expect(
            verifyHmacSha256Hex(rawBody, `  ${sig.toUpperCase()}  `, secret),
          ).toBe(true);

          const tamperedBody = Buffer.from(`${payloadText}!`, 'utf8');
          expect(verifyHmacSha256Hex(tamperedBody, sig, secret)).toBe(false);
        },
      ),
    );
  });

  it('returns false safely without throwing on missing, short, oversized, or non-hex headers', () => {
    const secret = randomBytes(16).toString('hex');
    const body = Buffer.from('{"status":"SUCCEEDED"}', 'utf8');
    const valid = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyHmacSha256Hex(body, undefined, secret)).toBe(false);
    expect(verifyHmacSha256Hex(body, '', secret)).toBe(false);
    expect(verifyHmacSha256Hex(body, 'abc123', secret)).toBe(false);
    expect(verifyHmacSha256Hex(body, `${valid}00`, secret)).toBe(false);
    expect(verifyHmacSha256Hex(body, `${'z'.repeat(64)}`, secret)).toBe(false);
    expect(verifyHmacSha256Hex(body, valid, '')).toBe(false);
  });
});
