import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_64_REGEX = /^[\da-f]{64}$/i;

/**
 * Verifies an HMAC-SHA256 hex signature against an exact raw request buffer
 * using constant-time byte comparison. Never throws on malformed headers.
 */
export function verifyHmacSha256Hex(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const normalized = signatureHeader.trim().toLowerCase();
  if (!HEX_64_REGEX.test(normalized)) {
    return false;
  }

  const expectedHex = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(normalized, 'hex');

  return (
    expectedBuf.byteLength === actualBuf.byteLength &&
    timingSafeEqual(expectedBuf, actualBuf)
  );
}
