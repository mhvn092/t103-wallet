export const WALLET_ACCOUNT_FILTERS = [
  'AVAILABLE',
  'LOCKED',
  'RECEIVABLE',
  'ALL',
] as const;

export function parseStrictLimit(value: unknown): number {
  if (value === undefined || value === '') {
    return 20;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      return Number(trimmed);
    }
  }
  return Number.NaN;
}
