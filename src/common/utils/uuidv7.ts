import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * Generates an RFC-9562 time-ordered UUIDv7 string with monotonic sub-millisecond ordering
 * within a single process so B-tree inserts stay sequential.
 */
export function generateUuidV7(): string {
  const nowMs = Date.now();
  if (nowMs <= lastMs) {
    seq = (seq + 1) & 0x0fff;
    if (seq === 0) {
      lastMs += 1;
    }
  } else {
    lastMs = nowMs;
    seq = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }

  const bytes = randomBytes(16);
  const ts = BigInt(lastMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version 7 (0111) + 12-bit monotonic sequence in rand_a
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  // Variant RFC-4122 (10xx)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
