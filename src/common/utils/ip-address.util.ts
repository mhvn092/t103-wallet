export function normalizeIpAddress(rawIp: string | undefined): string {
  if (!rawIp) {
    return '';
  }
  return rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
}
