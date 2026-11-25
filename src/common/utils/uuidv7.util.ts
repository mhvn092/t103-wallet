/**
 * Returns the minimum valid RFC-9562 UUIDv7 value at `timestampMs`.
 * Any UUIDv7 generated strictly before `timestampMs` compares `<` this boundary.
 */
export function uuidV7LowerBoundForMs(timestampMs: number): string {
  const clampedMs = Math.max(0, Math.floor(timestampMs));
  const ts = BigInt(clampedMs);
  const bytes = Buffer.alloc(16);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70;
  bytes[8] = 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
